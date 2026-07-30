/**
 * cli/index.ts — the human-facing CLI. A thin formatter over the SAME read-only
 * service layer the MCP tools use (ExplorerService + ReputationVerifier + the
 * ranking engine), so there is no duplicated discovery/ranking logic.
 *
 * Subcommands: find <query> · profile <id> · rank <query|ids> · services ·
 * doctor · setup · serve · --help · --version. Flags override env (precedence:
 * flag → env → default). All diagnostics go to stderr; command output to stdout.
 *
 * TRUST BOUNDARY: every agent-authored string printed here (name / description /
 * service labels) comes out of the sanitized, labeled `selfDeclared` slot — never
 * raw explorer text — so pasted terminal output cannot smuggle control/bidi
 * sequences. This layer is read-only: no signer, no keys, no writes.
 */

import { loadConfig, type Config } from "../config.js";
import { createToolDeps, type ToolDeps } from "../tools/shared.js";
import {
  agentIds,
  agentScores,
  declaredReputation,
  deriveCapabilities,
  mapWithConcurrency,
  rankAndVerify,
  toRankInput,
  VERIFY_TOP_K,
  type RankedRow,
} from "../tools/shared.js";
import { RANKING, scoreAgent } from "../lib/ranking.js";
import type {
  DiscoveryCoverage,
  FindAgentsResult,
  GetAgentsParams,
} from "../lib/explorer.js";
import { MAX_AGENT_ID, resolveAgentId, validWalletOrNull } from "../lib/identifier.js";
import { buildSelfDeclaredFields, sanitizeText } from "../lib/sanitize.js";
import { parseQuery } from "../lib/nlparse.js";
import { classifyError } from "../lib/errors.js";
import { buildRegistryHealthView } from "../lib/registry-stats.js";
import { log, isLogLevel } from "../lib/logger.js";
import {
  NotFoundError,
  ValidationError,
  type AgentResponse,
} from "@trionlabs/stellar8004";
import { buildServer, SERVER_NAME } from "../server.js";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { executeSetup, formatSetupReport } from "./setup.js";

// ---------------------------------------------------------------------------
// Flag parsing (flag → env → default)
// ---------------------------------------------------------------------------

export interface CliFlags {
  command?: string;
  positionals: string[];
  network?: string;
  explorerUrl?: string;
  rpcUrl?: string;
  verify: boolean;
  noVerify: boolean;
  json: boolean;
  x402: boolean;
  mpp: boolean;
  hasServices: boolean;
  limit?: number;
  minExplorerScore?: number;
  logLevel?: string;
  help: boolean;
  version: boolean;
  stdio: boolean;
  http: boolean;
  port?: number;
  client?: string;
  scope?: string;
  check: boolean;
  dryRun: boolean;
  handshake: boolean;
}

/** Flags that consume the next argv token as their value. */
const VALUE_FLAGS = new Map<string, keyof CliFlags>([
  ["--network", "network"],
  ["-n", "network"],
  ["--explorer-url", "explorerUrl"],
  ["--rpc-url", "rpcUrl"],
  ["--limit", "limit"],
  ["--min-explorer-score", "minExplorerScore"],
  ["--log-level", "logLevel"],
  ["--port", "port"],
  ["--client", "client"],
  ["--scope", "scope"],
]);

/** Parse argv (already sliced past node + script) into a flag bag. */
export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    positionals: [],
    verify: false,
    noVerify: false,
    json: false,
    x402: false,
    mpp: false,
    hasServices: false,
    help: false,
    version: false,
    stdio: false,
    http: false,
    check: false,
    dryRun: false,
    handshake: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (VALUE_FLAGS.has(tok)) {
      const key = VALUE_FLAGS.get(tok)!;
      const val = argv[++i];
      if (val === undefined) throw new Error(`Missing value for ${tok}`);
      if (key === "limit" || key === "port" || key === "minExplorerScore") {
        const n = Number(val);
        const [min, max] = key === "limit" ? [1, 50] : key === "port" ? [1, 65_535] : [0, Number.MAX_SAFE_INTEGER];
        if (!/^\d+$/.test(val) || !Number.isSafeInteger(n) || n < min || n > max) {
          throw new Error(`${tok} expects an integer from ${min} to ${max}, got '${val}'`);
        }
        (flags[key] as number) = n;
      } else {
        (flags[key] as string) = val;
      }
      continue;
    }
    switch (tok) {
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--version":
      case "-V":
        flags.version = true;
        break;
      case "--no-verify":
        flags.noVerify = true;
        break;
      case "--verify":
        flags.verify = true;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--x402":
        flags.x402 = true;
        break;
      case "--mpp":
        flags.mpp = true;
        break;
      case "--has-services":
        flags.hasServices = true;
        break;
      case "--stdio":
        flags.stdio = true;
        break;
      case "--http":
        flags.http = true;
        break;
      case "--check":
        flags.check = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--handshake":
        flags.handshake = true;
        break;
      case "--min-score":
        throw new Error(
          "--min-score is ambiguous and no longer supported; use --min-explorer-score for the upstream v1 Explorer total_score filter",
        );
      default:
        if (tok.startsWith("-")) throw new Error(`Unknown flag: ${tok}`);
        flags.positionals.push(tok);
    }
  }

  if (flags.verify && flags.noVerify) {
    throw new Error("--verify and --no-verify are mutually exclusive");
  }
  flags.command = flags.positionals[0];
  return flags;
}

/** Build a Config from flags, overlaying flag values onto the process env. */
export function buildConfig(flags: CliFlags, baseEnv: NodeJS.ProcessEnv = process.env): Config {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (flags.network) env.STELLAR_NETWORK = flags.network;
  if (flags.explorerUrl) env.EXPLORER_BASE_URL = flags.explorerUrl;
  if (flags.rpcUrl) env.STELLAR_RPC_URL = flags.rpcUrl;
  if (flags.verify) env.VERIFY_ONCHAIN = "true";
  if (flags.noVerify) env.VERIFY_ONCHAIN = "false";
  // Apply --log-level to the process logger before any deps (and their child
  // loggers) are constructed. The logger reads LOG_LEVEL at import, so the flag
  // must set the level explicitly here to take effect.
  if (flags.logLevel && isLogLevel(flags.logLevel)) log.setLevel(flags.logLevel);
  return loadConfig(env);
}

// ---------------------------------------------------------------------------
// Small terminal helpers (no deps)
// ---------------------------------------------------------------------------

function out(line = ""): void {
  process.stdout.write(line + "\n");
}

function err(line = ""): void {
  process.stderr.write(line + "\n");
}

const CHECK = "✔";
const CROSS = "✗";
const INFO = "ℹ";

/** Fixed-width table: pad each column to the widest cell. Right-aligns numerics. */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const numericCol = headers.map((_, i) => rows.every((r) => /^-?\d+(\.\d+)?$/.test(r[i] ?? "")));
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => (numericCol[i] ? (c ?? "").padStart(widths[i]) : (c ?? "").padEnd(widths[i])))
      .join("  ");
  const lines = [fmt(headers), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of rows) lines.push(fmt(r));
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function yn(b: boolean): string {
  return b ? "yes" : "-";
}

/** Name from the sanitized, labeled self-declared slot (never raw text). */
function rowName(r: RankedRow): string {
  return r.selfDeclared.value.name ?? "(unnamed)";
}

function rankRowsTable(rows: RankedRow[]): string {
  const body = rows.map((r) => [
    String(r.rank),
    String(r.id),
    String(r.score),
    r.verification?.status ?? "n/a",
    yn(r.capabilities.x402),
    yn(r.capabilities.mpp),
    // List/search rows intentionally omit detail-only services[]. The typed
    // hasServices flag is authoritative for this table; printing the local
    // array length falsely showed 0 for service-bearing agents.
    yn(r.capabilities.hasServices),
    truncate(rowName(r), 32),
  ]);
  return table(
    ["#", "ID", "SCORE", "STATUS", "X402", "MPP", "SVC", "NAME (self-declared, unverified)"],
    body,
  );
}

// ---------------------------------------------------------------------------
// Query candidate gathering (mirrors the tool handlers)
// ---------------------------------------------------------------------------

const CANDIDATE_PAGE_SIZE = 50;
const CANDIDATE_PAGES = 2;
/** Bound CLI-originated Explorer/RPC fan-out independently of result limits. */
const CLI_FANOUT_CONCURRENCY = 4;

function cliFanoutConcurrency(deps: ToolDeps): number {
  return Math.max(
    1,
    Math.min(CLI_FANOUT_CONCURRENCY, deps.policy?.maxExplorerConcurrency ?? CLI_FANOUT_CONCURRENCY),
  );
}

/** Preserve any stricter transport policy while imposing the CLI ceiling. */
function cliBoundedDeps(deps: ToolDeps): ToolDeps {
  const configured = deps.policy?.maxVerificationConcurrency ?? CLI_FANOUT_CONCURRENCY;
  return {
    ...deps,
    policy: {
      ...deps.policy,
      maxVerificationConcurrency: Math.max(1, Math.min(CLI_FANOUT_CONCURRENCY, configured)),
    },
  };
}

async function gatherByQuery(deps: ToolDeps, query: string, flags: CliFlags): Promise<FindAgentsResult> {
  const parsed = parseQuery(query);
  if (parsed.unsupported.length > 0) {
    throw new ValidationError(
      `Negative capability filters are not supported by Explorer v1: ${parsed.unsupported.join(", ")}.`,
    );
  }
  const filters: Record<string, unknown> = { limit: CANDIDATE_PAGE_SIZE };
  const x402 = flags.x402 || parsed.filters.x402;
  const hasServices = flags.hasServices || parsed.filters.hasServices;
  const trust = parsed.filters.trust;
  const minExplorerScore = flags.minExplorerScore ?? parsed.filters.minExplorerScore;
  if (x402 !== undefined && x402) filters.x402 = true;
  if (flags.mpp || parsed.filters.mpp) filters.mpp = true;
  if (hasServices !== undefined && hasServices) filters.hasServices = true;
  if (trust !== undefined) filters.trust = trust;
  if (minExplorerScore !== undefined) filters.minScore = minExplorerScore;

  return deps.explorer.findAgentsWithCoverage(parsed.keywords.join(" "), {
    filters,
    pages: CANDIDATE_PAGES,
    match: "any",
  });
}

function coverageNotice(coverage: DiscoveryCoverage): string | null {
  if (coverage.coverageComplete) return null;
  const more = coverage.hasMore === true ? "; additional explorer pages exist" : "";
  return `${INFO} bounded discovery scanned ${coverage.recordsScanned} record(s) across ` +
    `${coverage.pagesScanned} page(s)${more}; results are not registry-global.`;
}

async function gatherByIds(deps: ToolDeps, ids: number[]): Promise<AgentResponse[]> {
  const results = await mapWithConcurrency(
    ids,
    cliFanoutConcurrency(deps),
    async (id) => {
      try {
        return (await deps.explorer.getAgent(id)).data;
      } catch (e) {
        if (e instanceof NotFoundError) return null;
        throw e;
      }
    },
  );
  return results.filter((a): a is AgentResponse => a != null);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdFind(deps: ToolDeps, flags: CliFlags): Promise<number> {
  const query = flags.positionals.slice(1).join(" ").trim();
  if (!query) {
    err("usage: stellar-agent-search find <query> [--x402] [--mpp] [--limit N] [--verify] [--json]");
    return 2;
  }
  const discovery = await gatherByQuery(deps, query, flags);
  const rows = await rankAndVerify(cliBoundedDeps(deps), discovery.agents, {
    sortBy: "relevance",
    // Discovery remains fast by default; --verify is an explicit bounded RPC opt-in.
    verify: flags.verify,
    verifyTopK: Math.min(flags.limit ?? 10, VERIFY_TOP_K),
    limit: flags.limit ?? 10,
    includeBreakdown: false,
  });
  if (flags.json) {
    out(JSON.stringify({ query, count: rows.length, agents: rows, coverage: discovery.coverage }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    out(`No agents matched "${query}" on ${deps.config.network}.`);
    return 0;
  }
  out(`${rows.length} agent(s) for "${query}" on ${deps.config.network}:`);
  out();
  out(rankRowsTable(rows));
  out();
  out(`${INFO} names/descriptions are self-declared & unverified. Run: profile <id> for detail.`);
  const notice = coverageNotice(discovery.coverage);
  if (notice) out(notice);
  return 0;
}

async function cmdRank(deps: ToolDeps, flags: CliFlags): Promise<number> {
  const rest = flags.positionals.slice(1);
  if (rest.length === 0) {
    err("usage: stellar-agent-search rank <query | id id ...> [--limit N] [--no-verify] [--json]");
    return 2;
  }
  // All positionals numeric ⇒ explicit id set; otherwise treat as a query.
  const allNumeric = rest.every((t) => /^\d+$/.test(t));
  let pool: AgentResponse[];
  let coverage: DiscoveryCoverage | undefined;
  if (allNumeric) {
    const ids = rest.map(Number);
    if (ids.some((id) => !Number.isSafeInteger(id) || id < 0 || id > MAX_AGENT_ID)) {
      throw new ValidationError(`Agent ids must be integers from 0 to ${MAX_AGENT_ID}.`);
    }
    pool = await gatherByIds(deps, ids);
  } else {
    const discovery = await gatherByQuery(deps, rest.join(" "), flags);
    pool = discovery.agents;
    coverage = discovery.coverage;
  }

  if (pool.length === 0) {
    out(allNumeric ? `No agents found for ids [${rest.join(", ")}].` : `No agents matched.`);
    return 0;
  }

  const rows = await rankAndVerify(cliBoundedDeps(deps), pool, {
    sortBy: "relevance",
    verify: !flags.noVerify,
    verifyTopK: Math.min(flags.limit ?? 10, 25),
    limit: flags.limit ?? 10,
    includeBreakdown: true,
  });

  if (flags.json) {
    out(
      JSON.stringify(
        {
          rankVersion: RANKING.VERSION,
          evidenceWeights: {
            volume: RANKING.EVIDENCE_VOLUME_WEIGHT,
            breadth: RANKING.EVIDENCE_BREADTH_WEIGHT,
          },
          count: rows.length,
          agents: rows,
          ...(coverage ? { coverage } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  out(
    `Ranked ${rows.length} agent(s) on ${deps.config.network} ` +
      `(policy ${RANKING.VERSION}; evidence volume=${RANKING.EVIDENCE_VOLUME_WEIGHT} breadth=${RANKING.EVIDENCE_BREADTH_WEIGHT}):`,
  );
  out();
  out(rankRowsTable(rows));
  out();
  for (const r of rows.slice(0, 3)) {
    const b = r.breakdown;
    if (!b) continue;
    out(
      `  agent ${r.id}: quality ${b.quality.norm.toFixed(3)} × evidence ${b.evidenceStrength.toFixed(3)} ` +
        `(capped volume ${b.volume.weighted.toFixed(3)} + breadth ${b.breadth.weighted.toFixed(3)}) ` +
        `= score ${b.score.toFixed(3)}; owner-declared capability contribution 0`,
    );
  }
  if (coverage) {
    const notice = coverageNotice(coverage);
    if (notice) out(notice);
  }
  return 0;
}

async function cmdProfile(deps: ToolDeps, flags: CliFlags): Promise<number> {
  const ref = flags.positionals[1];
  if (!ref) {
    err("usage: stellar-agent-search profile <id | stellar:...#id> [--no-verify] [--json]");
    return 2;
  }
  const id = resolveAgentId(ref, {
    network: deps.config.network,
    identity: deps.config.stellar.contracts.identity,
  });
  if (id == null) {
    err(`Could not resolve agent reference '${ref}'.`);
    return 2;
  }

  const detail = (await deps.explorer.getAgent(id)).data;
  const declared = declaredReputation(detail);
  const verification = await deps.verifier.verifyAgainst(id, declared, {
    skip: flags.noVerify,
    excludeClient: detail.owner,
  });
  const result = scoreAgent(toRankInput(detail, verification.status), {
    scoreMax: deps.config.scoreMax,
  });
  const ids = agentIds(deps.config, id);
  const caps = deriveCapabilities(detail);
  const scores = agentScores(detail);
  const self = buildSelfDeclaredFields({
    name: detail.name ?? null,
    description: detail.description ?? null,
    image: detail.image ?? null,
    services: detail.services ?? null,
    metadata: detail.metadata ?? null,
  });

  if (flags.json) {
    out(
      JSON.stringify(
        { id, stellarId: ids.stellarId, caip2Id: ids.caip2Id, network: deps.config.network, owner: sanitizeText(detail.owner, 60), wallet: validWalletOrNull(detail.wallet), capabilities: caps, scores, verification, rank: result, selfDeclared: self },
        null,
        2,
      ),
    );
    return 0;
  }

  out(`Agent ${id}  (${deps.config.network})`);
  out(`  stellarId : ${ids.stellarId}`);
  out(`  owner     : ${sanitizeText(detail.owner, 60)}`);
  out(`  wallet    : ${validWalletOrNull(detail.wallet) ?? "(none — payTo comes from the x402 challenge)"}`);
  out(
    `  score     : ${result.score100}/100   evidence ${result.evidenceStrength.toFixed(3)} ` +
      `(index, not probability; ${result.rankVersion})`,
  );
  out(
    `  reputation: ${verification.status}` +
      (verification.verified
        ? `  (declared avg ${declared.average ?? "n/a"} vs on-chain ${verification.verified.average})`
        : `  (declared avg ${declared.average ?? "n/a"} over ${declared.feedbackCount} feedback)`),
  );
  if (verification.verified) {
    out("  evidence  : bounded, unversioned observations; snapshotComparable=no; active clients not chain-derived");
  } else if (verification.reason) {
    out(`  evidence  : ${verification.reason}; snapshotComparable=no; no reputation field verified`);
  }
  out(`  capability: x402=${yn(caps.x402)} mpp=${yn(caps.mpp)} services=${self.services.length} trust=[${caps.supportedTrust.join(", ")}]`);
  const fl = Object.entries(result.flags)
    .filter(([k, v]) => v && k !== "lowConfidence")
    .map(([k]) => k);
  if (fl.length) out(`  flags     : ${fl.join(", ")}`);
  out();
  out(`  self-declared (UNVERIFIED):`);
  out(`    name        : ${self.name ?? "(unnamed)"}`);
  if (self.description) out(`    description : ${truncate(self.description, 100)}`);
  for (const s of self.services) {
    out(`    service     : ${s.name} → ${s.endpoint}${s.version ? ` (v${s.version})` : ""}`);
  }
  return 0;
}

async function cmdServices(deps: ToolDeps, flags: CliFlags): Promise<number> {
  const limit = flags.limit ?? 20;
  const search = flags.positionals.slice(1).join(" ").trim();
  const filters: Omit<NonNullable<GetAgentsParams>, "search" | "page"> = {
    hasServices: true,
    limit: CANDIDATE_PAGE_SIZE,
  };
  if (flags.x402) filters.x402 = true;
  if (flags.mpp) filters.mpp = true;
  if (flags.minExplorerScore !== undefined) filters.minScore = flags.minExplorerScore;

  // Discover via stem-matching (the explorer `search=` misses "Scrapper").
  const discovery = await deps.explorer.findAgentsWithCoverage(search, {
    filters,
    pages: CANDIDATE_PAGES,
    match: "any",
  });
  const pool = discovery.agents;

  const scored = pool
    .map((a) => ({ a, result: scoreAgent(toRankInput(a), { scoreMax: deps.config.scoreMax }) }))
    .sort((x, y) => y.result.score100 - x.result.score100);

  // The LIST endpoint omits services[] + metadata, so hydrate the top agents via
  // getAgent(id) — otherwise every agent yields zero service rows. MPP filtering
  // is already pushed to the explorer, so hydrate only the requested window.
  const head = scored.slice(0, limit);
  let hydrationMissing = 0;
  const hydrated = await mapWithConcurrency(
    head,
    cliFanoutConcurrency(deps),
    ({ a }) =>
      deps.explorer
        .getAgent(a.id)
        .then((r) => r.data)
        .catch((error: unknown) => {
          // A list row may disappear before its detail read. Skip only that
          // typed race; an outage/timeout/auth failure must fail the command.
          if (error instanceof NotFoundError) {
            hydrationMissing++;
            return null;
          }
          throw error;
        }),
  );
  const pairs = head
    .map((s, i) => (hydrated[i] ? { a: hydrated[i]!, result: s.result } : null))
    .filter((pair): pair is NonNullable<typeof pair> => pair !== null);
  const hydrationUnversioned = head.length > 0;
  const coverageLimitations = [
    ...(discovery.coverage.limitations ?? []),
    ...(hydrationUnversioned ? ["detail-hydration-unversioned"] : []),
  ];
  const coverage = {
    ...discovery.coverage,
    coverageComplete:
      discovery.coverage.coverageComplete &&
      hydrationMissing === 0 &&
      !hydrationUnversioned,
    snapshotConsistent:
      discovery.coverage.snapshotConsistent && !hydrationUnversioned,
    hydrationMissing,
    detailsHydrated: head.length,
    ...(coverageLimitations.length > 0
      ? { limitations: [...new Set(coverageLimitations)] }
      : {}),
  };

  const rows: string[][] = [];
  const jsonRows: unknown[] = [];
  let agentsWithServices = 0;
  for (const { a, result } of pairs) {
    const caps = deriveCapabilities(a);
    const ids = agentIds(deps.config, a.id);
    const services = buildSelfDeclaredFields({ services: a.services ?? null }).services;
    if (services.length === 0) continue;
    agentsWithServices++;
    for (const svc of services) {
      rows.push([
        String(a.id),
        String(result.score100),
        yn(caps.x402),
        yn(caps.mpp),
        truncate(svc.name, 24),
        truncate(svc.endpoint, 44),
      ]);
      jsonRows.push({
        agentId: a.id,
        stellarId: ids.stellarId,
        caip2Id: ids.caip2Id,
        capabilities: { x402: caps.x402, mpp: caps.mpp },
        capabilitiesVerified: false,
        trustVerified: false,
        score: result.score100,
        endpointVerified: false,
        livenessVerified: false,
        protocolConformanceVerified: false,
        paymentVerified: false,
        service: svc,
      });
    }
  }

  if (flags.json) {
    out(JSON.stringify({ count: jsonRows.length, services: jsonRows, coverage }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    out(
      hydrationMissing > 0
        ? `No services could be returned on ${deps.config.network}; ${hydrationMissing} agent(s) disappeared during hydration.`
        : `No services found on ${deps.config.network}.`,
    );
    const notice = coverageNotice(coverage);
    if (notice) out(notice);
    return 0;
  }
  out(`${rows.length} self-declared service candidate(s) across ${agentsWithServices} agent(s) on ${deps.config.network}:`);
  out();
  out(table(["AGENT", "SCORE", "X402", "MPP", "SERVICE (self-declared)", "ENDPOINT (self-declared)"], rows));
  out(`${INFO} Endpoint liveness, ownership, protocol conformance, and payment behavior were not verified.`);
  const notice = coverageNotice(coverage);
  if (notice) out(notice);
  if (hydrationMissing > 0) {
    out(`${INFO} ${hydrationMissing} agent(s) disappeared between list and detail reads.`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// doctor — self-check
// ---------------------------------------------------------------------------

async function fetchJson(url: string, init: RequestInit, timeoutMs = 6000): Promise<{ ok: boolean; status: number; json: unknown }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

async function cmdDoctor(deps: ToolDeps, flags: CliFlags): Promise<number> {
  const cfg = deps.config;
  interface Check {
    name: string;
    ok: boolean;
    detail: string;
  }
  const checks: Check[] = [];

  // 1. node
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", ok: major >= 22, detail: `v${process.versions.node} (>=22 required)` });

  // 2. network + read-only posture
  checks.push({ name: "network", ok: true, detail: cfg.network });
  const keyless = !process.env.STELLAR_PRIVATE_KEY;
  checks.push({
    name: "read-only",
    ok: true,
    detail: keyless ? "keyless (no signer, no writes)" : "STELLAR_PRIVATE_KEY present but IGNORED (keyless)",
  });

  // 3. explorer health
  try {
    const health = buildRegistryHealthView(
      (await deps.explorer.health()).data,
      cfg.network,
    );
    const indexerDetail = (["identity", "reputation", "validation"] as const)
      .map((name) => {
        const state = health.indexer[name];
        return `${name}=${state.lastLedger}/${state.stale ? "STALE" : "fresh"}`;
      })
      .join(" ");
    checks.push({
      name: "explorer",
      ok: health.status === "healthy" && !health.anyStale,
      detail: `${cfg.explorerBaseUrl}  status=${health.status}  ${indexerDetail}`,
    });
  } catch (e) {
    checks.push({ name: "explorer", ok: false, detail: `${cfg.explorerBaseUrl}  ${classifyError(e).error}` });
  }

  // 4. soroban RPC reachability (getHealth)
  try {
    const r = await fetchJson(cfg.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    const status = (r.json as { result?: { status?: string } })?.result?.status;
    checks.push({ name: "soroban", ok: r.ok && status === "healthy", detail: `${cfg.rpcUrl}  ${status ?? `HTTP ${r.status}`}` });
  } catch (e) {
    checks.push({ name: "soroban", ok: false, detail: `${cfg.rpcUrl}  ${(e as Error).message}` });
  }

  // 5. exact Reputation-contract read-path health (agent #10 exists on mainnet)
  if (cfg.verifyOnchain) {
    try {
      // Reachability is not comparability. The current contract exposes no
      // authoritative client-count/cursor, so doctor checks the real simulation
      // path without turning a successful bounded read into a verification claim.
      const probe = await deps.verifier.probeReachability(10);
      if (probe.ok) {
        checks.push({
          name: "contract",
          ok: true,
          detail: `read path OK (sample #10 returned ${probe.observedClients} address(es) from bounded indices ${probe.start}..${probe.start + probe.limit - 1}; not an exhaustive client count; verification unavailable)`,
        });
      } else {
        checks.push({
          name: "contract",
          ok: false,
          detail: `read path FAILED (${probe.reason})${probe.detail ? `: ${probe.detail}` : ""}`,
        });
      }
    } catch (e) {
      checks.push({ name: "contract", ok: false, detail: `sample read failed: ${classifyError(e).error}` });
    }
  } else {
    checks.push({ name: "contract", ok: true, detail: "disabled (VERIFY_ONCHAIN=false / --no-verify)" });
  }

  // 6. tools registered
  checks.push({
    name: "tools",
    ok: true,
    detail: "find_agent, rank_agent, get_agent_profile, list_services (+ list_agents, leaderboard)",
  });

  if (flags.json) {
    out(JSON.stringify({ ok: checks.every((c) => c.ok), network: cfg.network, checks }, null, 2));
  } else {
    for (const c of checks) {
      out(`${c.ok ? CHECK : CROSS} ${c.name.padEnd(9)} ${c.detail}`);
    }
    out(`${INFO} server    ${SERVER_NAME}  ·  @modelcontextprotocol/server 2.0.0  ·  spec 2025-11-25`);
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}

// ---------------------------------------------------------------------------
// serve — explicit MCP stdio start (also the client default)
// ---------------------------------------------------------------------------

/**
 * Start the MCP server over stdio and block until the transport closes.
 * stdout is JSON-RPC ONLY; every log goes to stderr. Installs graceful
 * SIGINT/SIGTERM handlers that close the server before exiting.
 */
export async function startMcpServer(flags: CliFlags, version: string): Promise<void> {
  if (flags.http) {
    err(
      "serve --http is intentionally not embedded in the Node CLI. The remote Streamable HTTP transport " +
        "is the separately deployed Cloudflare Worker at https://mcp.stellar8004.com/mcp.",
    );
    process.exitCode = 1;
    return;
  }
  const config = buildConfig(flags);
  const server = buildServer(config, { version });
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    err(`${SERVER_NAME}: received ${signal}, shutting down`);
    try {
      await server.close();
    } catch (e) {
      err(`${SERVER_NAME}: error during shutdown: ${(e as Error).message}`);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  err(`${SERVER_NAME}: MCP stdio server ready on ${config.network} (read-only, keyless)`);
}

// ---------------------------------------------------------------------------
// Help / version
// ---------------------------------------------------------------------------

export function printHelp(): void {
  out(`stellar-agent-search — discover, rank & inspect on-chain Stellar 8004 agents (read-only)

USAGE
  stellar-agent-search <command> [args] [flags]
  stellar-agent-search                       # no args, launched by an MCP client → stdio server

COMMANDS
  find <query>            Natural-language discovery → ranked candidates
  rank <query | id...>    Rank a query's candidates or an explicit id set (3-axis + evidence limits)
  profile <id>            Full profile: identity, capabilities, declared reputation + evidence limits
  services [search]       Catalog of self-declared x402/MPP endpoint candidates
  doctor                  Self-check: env, explorer health, RPC reachability, read-only posture
  setup --client <name>   Idempotently register with Claude Code, Cursor, or Codex
  serve                   Explicitly start the MCP stdio server
  --help, -h              Show this help
  --version, -V           Print version

FLAGS
  --network <mainnet|testnet>   Network (env STELLAR_NETWORK; default mainnet)
  --explorer-url <url>          Explorer API base (env EXPLORER_BASE_URL)
  --rpc-url <url>               Soroban RPC (env STELLAR_RPC_URL)
  --verify                      Attempt bounded on-chain evidence reads for find results (off by default)
  --no-verify                   Skip on-chain reputation evidence reads (env VERIFY_ONCHAIN=false)
  --x402                        Require x402 (pay-per-call) support
  --mpp                         Require MPP micropayment support
  --min-explorer-score <n>      Minimum upstream v1 Explorer total_score (not local rank)
  --limit <N>                   Max rows
  --json                        Machine-readable output
  --client <claude|cursor|codex>  Client to configure (setup only)
  --scope <user|project>          Config scope (setup; default user)
  --check                        Check registration without changing it
  --dry-run                      Print the planned registration without changing it
  --handshake                    Initialize this package and list its MCP tools
  (precedence: flag → env → default)

Agent names/descriptions/services are self-declared & UNVERIFIED. Reputation evidence fails closed: the
current contract has no authoritative client-set cursor/count, so no reputation field is marked verified.`);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const CLI_COMMANDS = new Set(["find", "rank", "profile", "services", "doctor", "setup"]);

/**
 * Run the human CLI for the given parsed flags. Returns a process exit code.
 * `serve` (and default no-command) starts the MCP server via startMcpServer.
 */
export async function runCli(
  flags: CliFlags,
  version: string,
  /** Test/embedding seam; production callers omit this and use configured deps. */
  depsOverride?: ToolDeps,
): Promise<number> {
  if (flags.version) {
    out(version);
    return 0;
  }
  if (flags.help || !flags.command) {
    printHelp();
    return 0;
  }
  if (flags.command === "serve") {
    await startMcpServer(flags, version);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }
  if (!CLI_COMMANDS.has(flags.command)) {
    err(`Unknown command: ${flags.command}`);
    printHelp();
    return 1;
  }

  try {
    if (flags.command === "setup") {
      const result = await executeSetup({
        client: flags.client,
        scope: flags.scope,
        check: flags.check,
        dryRun: flags.dryRun,
        handshake: flags.handshake,
        json: flags.json,
        network: flags.network,
        explorerUrl: flags.explorerUrl,
        rpcUrl: flags.rpcUrl,
        noVerify: flags.noVerify,
        version,
      });
      out(flags.json ? JSON.stringify(result.report, null, 2) : formatSetupReport(result.report));
      return result.code;
    }

    const deps = depsOverride ?? createToolDeps(buildConfig(flags));
    switch (flags.command) {
      case "find":
        return await cmdFind(deps, flags);
      case "rank":
        return await cmdRank(deps, flags);
      case "profile":
        return await cmdProfile(deps, flags);
      case "services":
        return await cmdServices(deps, flags);
      case "doctor":
        return await cmdDoctor(deps, flags);
      default:
        printHelp();
        return 1;
    }
  } catch (e) {
    const body = classifyError(e);
    err(`error: ${body.error}${body.detail ? ` (${body.detail})` : ""}`);
    return 1;
  }
}
