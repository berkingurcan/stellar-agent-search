/**
 * cli/index.ts — the human-facing CLI. A thin formatter over the SAME read-only
 * service layer the MCP tools use (ExplorerService + ReputationVerifier + the
 * ranking engine), so there is no duplicated discovery/ranking logic.
 *
 * Subcommands: find <query> · profile <id> · rank <query|ids> · services ·
 * doctor · serve · --help · --version. Flags override env (precedence:
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
  rankAndVerify,
  toRankInput,
  type RankedRow,
} from "../tools/shared.js";
import { scoreAgent } from "../lib/ranking.js";
import { resolveAgentId } from "../lib/identifier.js";
import { buildSelfDeclaredFields } from "../lib/sanitize.js";
import { parseQuery } from "../lib/nlparse.js";
import { classifyError } from "../lib/errors.js";
import { NotFoundError, type AgentResponse } from "@trionlabs/stellar8004";
import { buildServer, SERVER_NAME } from "../server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// ---------------------------------------------------------------------------
// Flag parsing (flag → env → default)
// ---------------------------------------------------------------------------

export interface CliFlags {
  command?: string;
  positionals: string[];
  network?: string;
  explorerUrl?: string;
  rpcUrl?: string;
  noVerify: boolean;
  json: boolean;
  x402: boolean;
  mpp: boolean;
  hasServices: boolean;
  limit?: number;
  minScore?: number;
  logLevel?: string;
  help: boolean;
  version: boolean;
  stdio: boolean;
  http: boolean;
  port?: number;
}

/** Flags that consume the next argv token as their value. */
const VALUE_FLAGS = new Map<string, keyof CliFlags>([
  ["--network", "network"],
  ["-n", "network"],
  ["--explorer-url", "explorerUrl"],
  ["--rpc-url", "rpcUrl"],
  ["--limit", "limit"],
  ["--min-score", "minScore"],
  ["--log-level", "logLevel"],
  ["--port", "port"],
]);

/** Parse argv (already sliced past node + script) into a flag bag. */
export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    positionals: [],
    noVerify: false,
    json: false,
    x402: false,
    mpp: false,
    hasServices: false,
    help: false,
    version: false,
    stdio: false,
    http: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (VALUE_FLAGS.has(tok)) {
      const key = VALUE_FLAGS.get(tok)!;
      const val = argv[++i];
      if (val === undefined) throw new Error(`Missing value for ${tok}`);
      if (key === "limit" || key === "port" || key === "minScore") {
        const n = Number(val);
        if (!Number.isFinite(n)) throw new Error(`${tok} expects a number, got '${val}'`);
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
      default:
        if (tok.startsWith("-")) throw new Error(`Unknown flag: ${tok}`);
        flags.positionals.push(tok);
    }
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
  if (flags.noVerify) env.VERIFY_ONCHAIN = "false";
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
    String(r.selfDeclared.value.services.length),
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

async function gatherByQuery(deps: ToolDeps, query: string, flags: CliFlags): Promise<AgentResponse[]> {
  const parsed = parseQuery(query);
  const filters: Record<string, unknown> = { limit: CANDIDATE_PAGE_SIZE };
  const x402 = flags.x402 || parsed.filters.x402;
  const hasServices = flags.hasServices || parsed.filters.hasServices;
  const trust = parsed.filters.trust;
  const minScore = flags.minScore ?? parsed.filters.minScore;
  if (x402 !== undefined && x402) filters.x402 = true;
  if (hasServices !== undefined && hasServices) filters.hasServices = true;
  if (trust !== undefined) filters.trust = trust;
  if (minScore !== undefined) filters.minScore = minScore;

  let pool = await deps.explorer.findAgents(parsed.keywords.join(" "), {
    filters,
    pages: CANDIDATE_PAGES,
    match: "any",
  });
  if (flags.mpp || parsed.filters.mpp) pool = pool.filter((a) => deriveCapabilities(a).mpp);
  return pool;
}

async function gatherByIds(deps: ToolDeps, ids: number[]): Promise<AgentResponse[]> {
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return (await deps.explorer.getAgent(id)).data;
      } catch (e) {
        if (e instanceof NotFoundError) return null;
        throw e;
      }
    }),
  );
  return results.filter((a): a is AgentResponse => a != null);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdFind(deps: ToolDeps, flags: CliFlags): Promise<number> {
  const query = flags.positionals.slice(1).join(" ").trim();
  if (!query) {
    err("usage: stellar-agent-mcp find <query> [--x402] [--mpp] [--limit N] [--verify] [--json]");
    return 2;
  }
  const pool = await gatherByQuery(deps, query, flags);
  const rows = await rankAndVerify(deps, pool, {
    weights: deps.config.weights,
    sortBy: "relevance",
    verify: false, // discovery: verification off for speed (use `rank` to verify)
    limit: flags.limit ?? 10,
    includeBreakdown: false,
  });
  if (flags.json) {
    out(JSON.stringify({ query, count: rows.length, agents: rows }, null, 2));
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
  return 0;
}

async function cmdRank(deps: ToolDeps, flags: CliFlags): Promise<number> {
  const rest = flags.positionals.slice(1);
  if (rest.length === 0) {
    err("usage: stellar-agent-mcp rank <query | id id ...> [--limit N] [--no-verify] [--json]");
    return 2;
  }
  // All positionals numeric ⇒ explicit id set; otherwise treat as a query.
  const allNumeric = rest.every((t) => /^\d+$/.test(t));
  const pool = allNumeric
    ? await gatherByIds(deps, rest.map(Number))
    : await gatherByQuery(deps, rest.join(" "), flags);

  if (pool.length === 0) {
    out(allNumeric ? `No agents found for ids [${rest.join(", ")}].` : `No agents matched.`);
    return 0;
  }

  const rows = await rankAndVerify(deps, pool, {
    weights: deps.config.weights,
    sortBy: "relevance",
    verify: !flags.noVerify,
    verifyTopK: Math.min(flags.limit ?? 10, 25),
    limit: flags.limit ?? 10,
    includeBreakdown: true,
  });

  if (flags.json) {
    out(JSON.stringify({ count: rows.length, weights: deps.config.weights, agents: rows }, null, 2));
    return 0;
  }
  out(
    `Ranked ${rows.length} agent(s) on ${deps.config.network} ` +
      `(weights q=${deps.config.weights.quality} v=${deps.config.weights.volume} b=${deps.config.weights.breadth}):`,
  );
  out();
  out(rankRowsTable(rows));
  out();
  for (const r of rows.slice(0, 3)) {
    const b = r.breakdown;
    if (!b) continue;
    out(
      `  agent ${r.id}: base ${b.base.toFixed(3)} = ` +
        `quality ${b.quality.weighted.toFixed(3)} + volume ${b.volume.weighted.toFixed(3)} + ` +
        `breadth ${b.breadth.weighted.toFixed(3)}; bonuses pay=${b.paymentBonus.toFixed(2)} ` +
        `endpoint=${b.endpointBonus.toFixed(2)} verified=${b.verifiedBonus.toFixed(2)}; ` +
        `confidence ${Math.round(b.confidence * 100)}%`,
    );
  }
  return 0;
}

async function cmdProfile(deps: ToolDeps, flags: CliFlags): Promise<number> {
  const ref = flags.positionals[1];
  if (!ref) {
    err("usage: stellar-agent-mcp profile <id | stellar:...#id> [--no-verify] [--json]");
    return 2;
  }
  const id = resolveAgentId(ref);
  if (id == null) {
    err(`Could not resolve agent reference '${ref}'.`);
    return 2;
  }

  const detail = (await deps.explorer.getAgent(id)).data;
  const declared = declaredReputation(detail);
  const verification = await deps.verifier.verifyAgainst(id, declared, { skip: flags.noVerify });
  const result = scoreAgent(toRankInput(detail, verification.status), {
    weights: deps.config.weights,
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
        { id, stellarId: ids.stellarId, caip2Id: ids.caip2Id, network: deps.config.network, owner: detail.owner, wallet: detail.wallet ?? null, capabilities: caps, scores, verification, rank: result, selfDeclared: self },
        null,
        2,
      ),
    );
    return 0;
  }

  out(`Agent ${id}  (${deps.config.network})`);
  out(`  stellarId : ${ids.stellarId}`);
  out(`  owner     : ${detail.owner}`);
  out(`  wallet    : ${detail.wallet ?? "(none — payTo comes from the x402 challenge)"}`);
  out(`  score     : ${result.score100}/100   confidence ${Math.round(result.confidence * 100)}%`);
  out(
    `  reputation: ${verification.status}` +
      (verification.verified
        ? `  (declared avg ${declared.average ?? "n/a"} vs on-chain ${verification.verified.average})`
        : `  (declared avg ${declared.average ?? "n/a"} over ${declared.feedbackCount} feedback)`),
  );
  out(`  capability: x402=${yn(caps.x402)} mpp=${yn(caps.mpp)} services=${self.services.length} trust=[${caps.supportedTrust.join(", ")}]`);
  const fl = Object.entries(result.flags).filter(([, v]) => v).map(([k]) => k);
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
  const params: Record<string, unknown> = { hasServices: true, page: 1, limit: flags.limit ?? 20 };
  const search = flags.positionals.slice(1).join(" ").trim();
  if (search) params.search = search;
  if (flags.x402) params.x402 = true;
  if (flags.minScore !== undefined) params.minScore = flags.minScore;

  let agents = (await deps.explorer.getAgents(params)).data ?? [];
  if (flags.mpp) agents = agents.filter((a) => deriveCapabilities(a).mpp);

  const scored = agents
    .map((a) => ({ a, result: scoreAgent(toRankInput(a), { weights: deps.config.weights, scoreMax: deps.config.scoreMax }) }))
    .sort((x, y) => y.result.score100 - x.result.score100);

  const rows: string[][] = [];
  const jsonRows: unknown[] = [];
  for (const { a, result } of scored) {
    const caps = deriveCapabilities(a);
    const ids = agentIds(deps.config, a.id);
    const services = buildSelfDeclaredFields({ services: a.services ?? null }).services;
    for (const svc of services) {
      rows.push([
        String(a.id),
        String(result.score100),
        yn(caps.x402),
        yn(caps.mpp),
        truncate(svc.name, 24),
        truncate(svc.endpoint, 44),
      ]);
      jsonRows.push({ agentId: a.id, stellarId: ids.stellarId, caip2Id: ids.caip2Id, capabilities: { x402: caps.x402, mpp: caps.mpp }, score: result.score100, service: svc });
    }
  }

  if (flags.json) {
    out(JSON.stringify({ count: jsonRows.length, services: jsonRows }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    out(`No services found on ${deps.config.network}.`);
    return 0;
  }
  out(`${rows.length} service(s) across ${scored.length} agent(s) on ${deps.config.network}:`);
  out();
  out(table(["AGENT", "SCORE", "X402", "MPP", "SERVICE (self-declared)", "ENDPOINT (self-declared)"], rows));
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
  checks.push({ name: "node", ok: major >= 18, detail: `v${process.versions.node} (>=18 required)` });

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
    const health = (await deps.explorer.health()).data;
    const identity = health.indexer?.identity;
    const stale = identity?.stale ? "STALE" : "fresh";
    checks.push({
      name: "explorer",
      ok: health.status === "ok" || health.status === "healthy",
      detail: `${cfg.explorerBaseUrl}  status=${health.status}  identity ledger ${identity?.lastLedger ?? "?"} (${stale})`,
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

  // 5. on-chain verify sample (agent #10 exists on mainnet)
  if (cfg.verifyOnchain) {
    try {
      // The read path completing (even with an empty summary) proves the
      // reputation-contract simulation works; RPC liveness is checked above.
      const onchain = await deps.verifier.verify(10);
      checks.push({
        name: "verify",
        ok: true,
        detail:
          onchain != null
            ? `on-chain reputation read OK (sampled agent #10: avg ${onchain.average}, ${onchain.count} feedback)`
            : `on-chain read path OK (sampled agent #10 has no on-chain summary yet)`,
      });
    } catch (e) {
      checks.push({ name: "verify", ok: false, detail: `sample read failed: ${classifyError(e).error}` });
    }
  } else {
    checks.push({ name: "verify", ok: true, detail: "disabled (VERIFY_ONCHAIN=false / --no-verify)" });
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
    out(`${INFO} server    ${SERVER_NAME}  ·  @modelcontextprotocol/sdk 1.29.0  ·  spec 2025-11-25`);
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
    err("The Streamable HTTP transport (serve --http) is a post-v0.1.0 stretch and is not enabled in this build.");
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
  out(`stellar-agent-mcp — discover, rank & inspect on-chain Stellar 8004 agents (read-only)

USAGE
  stellar-agent-mcp <command> [args] [flags]
  stellar-agent-mcp                       # no args, launched by an MCP client → stdio server

COMMANDS
  find <query>            Natural-language discovery → ranked candidates
  rank <query | id...>    Rank a query's candidates or an explicit id set (3-axis + verify)
  profile <id>            Full profile: identity, capabilities, declared-vs-verified reputation
  services [search]       Catalog of callable x402/MPP service endpoints
  doctor                  Self-check: env, explorer health, RPC reachability, read-only posture
  serve                   Explicitly start the MCP stdio server
  --help, -h              Show this help
  --version, -V           Print version

FLAGS
  --network <mainnet|testnet>   Network (env STELLAR_NETWORK; default mainnet)
  --explorer-url <url>          Explorer API base (env EXPLORER_BASE_URL)
  --rpc-url <url>               Soroban RPC (env STELLAR_RPC_URL)
  --no-verify                   Skip on-chain reputation verification (env VERIFY_ONCHAIN=false)
  --x402                        Require x402 (pay-per-call) support
  --mpp                         Require MPP micropayment support
  --min-score <0..100>          Minimum declared reputation
  --limit <N>                   Max rows
  --json                        Machine-readable output
  (precedence: flag → env → default)

Agent names/descriptions/services are self-declared & UNVERIFIED; reputation is verified on-chain.`);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const CLI_COMMANDS = new Set(["find", "rank", "profile", "services", "doctor"]);

/**
 * Run the human CLI for the given parsed flags. Returns a process exit code.
 * `serve` (and default no-command) starts the MCP server via startMcpServer.
 */
export async function runCli(flags: CliFlags, version: string): Promise<number> {
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

  const deps = createToolDeps(buildConfig(flags));
  try {
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
