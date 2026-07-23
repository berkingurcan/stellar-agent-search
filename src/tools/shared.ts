/**
 * tools/shared.ts — cross-tool building blocks for the read-only tool surface.
 *
 * Owns: dependency wiring (ToolDeps), shared zod fragments, the read-only tool
 * annotations, the AgentResponse → typed-domain adapters, the rank+verify
 * pipeline, and the trust-boundary-safe output projections.
 *
 * TRUST BOUNDARY (non-negotiable #3): server-authored text (content[].text)
 * interpolates ONLY typed/enum/numeric values — enforced at compile time via
 * `serverText`/`safe`. Every untrusted agent-authored string (name/description/
 * service labels/endpoints/metadata/feedback tags) is confined to a labeled
 * `selfDeclared` slot inside structuredContent. Nothing untrusted is ever
 * interpolated into a summary line.
 */

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  AgentResponse,
  FeedbackResponse,
} from "@trionlabs/stellar8004";
import type { Config } from "../config.js";
import { ExplorerService } from "../lib/explorer.js";
import { ReputationVerifier } from "../lib/reputation.js";
import {
  rankAgents,
  type RankInput,
  type RankOptions,
  type SortMode,
} from "../lib/ranking.js";
import {
  buildCaip2Id,
  buildStellarId,
  validWalletOrNull,
} from "../lib/identifier.js";
import {
  buildSelfDeclaredFields,
  safe,
  sanitizeText,
  selfDeclared,
  serverText,
  CAPS,
  type SelfDeclared,
} from "../lib/sanitize.js";
import type {
  AgentCapabilities,
  AgentFlags,
  AgentScores,
  DeclaredReputation,
  Network,
  RankResult,
  RankWeights,
  SelfDeclaredFields,
  ToolResult,
  VerificationResult,
} from "../types.js";
import { toolResult } from "../types.js";
import { mapErrorToToolResult } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Dependency wiring
// ---------------------------------------------------------------------------

/** Everything a tool handler needs. Constructed once per server. */
export interface ToolDeps {
  config: Config;
  explorer: ExplorerService;
  verifier: ReputationVerifier;
}

/** Convenience factory: build the read-only deps from a loaded Config. */
export function createToolDeps(config: Config): ToolDeps {
  return {
    config,
    explorer: new ExplorerService(config),
    verifier: new ReputationVerifier(config),
  };
}

// ---------------------------------------------------------------------------
// Read-only tool annotations (identical for every tool in this server)
// ---------------------------------------------------------------------------

export const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ---------------------------------------------------------------------------
// Shared zod fragments
// ---------------------------------------------------------------------------

export const zTrust = z.enum(["reputation", "validation", "tee"]);
export const zSort = z.enum(["relevance", "score", "confidence", "newest"]);
export const zMinScore = z.number().min(0).max(100);

export function zLimit(def: number, max = 50) {
  return z.number().int().min(1).max(max).default(def);
}

/** Verification top-K default (bounds on-chain RPC cost). */
export const VERIFY_TOP_K = 5;

// ---------------------------------------------------------------------------
// AgentResponse → typed domain adapters
// ---------------------------------------------------------------------------

/**
 * Best-effort MPP detection (the explorer has no first-class MPP field).
 * NOTE: `metadata` is only present on DETAIL responses, so this returns false
 * for list rows — callers that filter on MPP must hydrate first (see filterMpp).
 */
function deriveMpp(a: AgentResponse): boolean {
  const rec = a as Record<string, unknown>;
  if (typeof rec.mpp === "boolean") return rec.mpp;
  if (typeof rec.mppEnabled === "boolean") return rec.mppEnabled;
  const md = a.metadata;
  if (md) {
    for (const [k, v] of Object.entries(md)) {
      const key = k.toLowerCase();
      // Match a whole known key and honor its VALUE. The old `key.includes("mpp")`
      // returned true for any substring hit ("tempPrice" contains "mpp") and
      // ignored the value, so {"mppEnabled":"false"} still enabled MPP.
      if (key === "mpp" || key === "mppenabled" || key === "mpp_enabled") {
        const val = String(v).trim().toLowerCase();
        return val === "true" || val === "1" || val === "yes" || val === "enabled";
      }
    }
  }
  return false;
}

/** Typed capabilities. supportedTrust is length/char-bounded but stays typed. */
export function deriveCapabilities(a: AgentResponse): AgentCapabilities {
  const services = a.services ?? [];
  const supportedTrust = (a.supportedTrust ?? [])
    .map((t) => sanitizeText(t, 40))
    .filter((t) => t.length > 0);
  return {
    x402: Boolean(a.x402Enabled),
    mpp: deriveMpp(a),
    hasServices: a.hasServices ?? services.length > 0,
    supportedTrust,
  };
}

/** Reputation as reported by the explorer/indexer (declared). */
export function declaredReputation(a: AgentResponse): DeclaredReputation {
  const feedbackCount = a.scores?.feedbackCount ?? a.feedbackCount ?? 0;
  const rawAvg = a.scores?.average ?? a.avgScore ?? null;
  return {
    average: feedbackCount > 0 && rawAvg != null ? rawAvg : null,
    feedbackCount,
    uniqueClients: a.scores?.uniqueClients ?? a.uniqueClients ?? 0,
  };
}

/** Joined score summary for a profile. */
export function agentScores(a: AgentResponse): AgentScores {
  const declared = declaredReputation(a);
  return {
    average: declared.average,
    total: a.scores?.total ?? a.totalScore ?? null,
    feedbackCount: declared.feedbackCount,
    uniqueClients: declared.uniqueClients,
  };
}

/** Map an AgentResponse into the pure ranking input. */
export function toRankInput(
  a: AgentResponse,
  verificationStatus?: VerificationResult["status"],
): RankInput {
  const caps = deriveCapabilities(a);
  const declared = declaredReputation(a);
  return {
    id: a.id,
    avg: declared.average,
    feedbackCount: declared.feedbackCount,
    uniqueClients: declared.uniqueClients,
    x402: caps.x402,
    mpp: caps.mpp,
    hasServices: caps.hasServices,
    verificationStatus,
    createdAt: a.createdAt ?? null,
  };
}

/** Build both identifier strings for an agent id. */
export function agentIds(config: Config, id: number): { stellarId: string; caip2Id: string } {
  const identity = config.stellar.contracts.identity;
  return {
    stellarId: buildStellarId(config.network, identity, id),
    caip2Id: buildCaip2Id(config.network, identity, id),
  };
}

/** Sanitized, labeled self-declared slot for one agent (untrusted text). */
export function selfDeclaredSlot(a: AgentResponse): SelfDeclared<SelfDeclaredFields> {
  return selfDeclared(
    buildSelfDeclaredFields({
      name: a.name ?? null,
      description: a.description ?? null,
      image: a.image ?? null,
      services: a.services ?? null,
      metadata: a.metadata ?? null,
    }),
  );
}

// ---------------------------------------------------------------------------
// Ranked-agent output row (trust-boundary safe)
// ---------------------------------------------------------------------------

export interface RankedRow {
  id: number;
  rank: number;
  /** score100 (0..100) */
  score: number;
  stellarId: string;
  caip2Id: string;
  network: Network;
  owner: string;
  wallet: string | null;
  capabilities: AgentCapabilities;
  supportedTrust: string[];
  scores: AgentScores;
  flags: AgentFlags;
  breakdown?: RankResult;
  verification?: VerificationResult;
  /** UNTRUSTED, labeled: name/description/services/metadata/image. */
  selfDeclared: SelfDeclared<SelfDeclaredFields>;
}

export function toRankedRow(
  config: Config,
  a: AgentResponse,
  rank: number,
  result: RankResult,
  opts: { verification?: VerificationResult; includeBreakdown?: boolean } = {},
): RankedRow {
  const ids = agentIds(config, a.id);
  const caps = deriveCapabilities(a);
  const row: RankedRow = {
    id: a.id,
    rank,
    score: result.score100,
    stellarId: ids.stellarId,
    caip2Id: ids.caip2Id,
    network: config.network,
    owner: sanitizeText(a.owner, 60),
    wallet: validWalletOrNull(a.wallet),
    capabilities: caps,
    supportedTrust: caps.supportedTrust,
    scores: agentScores(a),
    flags: result.flags,
    selfDeclared: selfDeclaredSlot(a),
  };
  if (opts.includeBreakdown) row.breakdown = result;
  if (opts.verification) row.verification = opts.verification;
  return row;
}

// ---------------------------------------------------------------------------
// Rank + (bounded) on-chain verification pipeline
// ---------------------------------------------------------------------------

export interface RankVerifyOptions {
  weights?: RankWeights;
  sortBy?: SortMode;
  verify: boolean;
  /** How many of the returned rows to on-chain verify (default VERIFY_TOP_K). */
  verifyTopK?: number;
  /** How many rows to return (post-sort slice). */
  limit: number;
  includeBreakdown?: boolean;
}

/**
 * Rank a candidate set, verify the top-K on-chain (bounded), then re-rank with
 * the verification bonus applied, and project to trust-boundary-safe rows.
 */
export async function rankAndVerify(
  deps: ToolDeps,
  agents: AgentResponse[],
  opts: RankVerifyOptions,
): Promise<RankedRow[]> {
  const byId = new Map<number, AgentResponse>();
  for (const a of agents) if (!byId.has(a.id)) byId.set(a.id, a);
  const unique = [...byId.values()];

  const rankOpts: RankOptions = {
    weights: opts.weights,
    scoreMax: deps.config.scoreMax,
    sortBy: opts.sortBy ?? "relevance",
  };

  // Pass 1 — rank without verification to decide the returned + verified sets.
  const pre = rankAgents(
    unique.map((a) => toRankInput(a)),
    rankOpts,
  );
  const returned = pre.slice(0, opts.limit);
  const verifyTopK = opts.verify ? (opts.verifyTopK ?? VERIFY_TOP_K) : 0;
  const verifyIds = new Set(returned.slice(0, verifyTopK).map((r) => r.id));

  // Verify (or skip) each returned agent. `skip` short-circuits without RPC.
  const verifications = new Map<number, VerificationResult>();
  await Promise.all(
    returned.map(async (r) => {
      const a = byId.get(r.id)!;
      const skip = !verifyIds.has(r.id);
      const v = await deps.verifier.verifyAgainst(r.id, declaredReputation(a), { skip });
      verifications.set(r.id, v);
    }),
  );

  // Pass 2 — re-rank the returned set with verification status applied.
  const finalRanked = rankAgents(
    returned.map((r) => toRankInput(byId.get(r.id)!, verifications.get(r.id)?.status)),
    rankOpts,
  );

  return finalRanked.map((r) =>
    toRankedRow(deps.config, byId.get(r.id)!, r.rank, r.result, {
      verification: verifications.get(r.id),
      includeBreakdown: opts.includeBreakdown,
    }),
  );
}

/** Bound on how many candidates filterMpp will hydrate per call (RPC/HTTP cost). */
export const MPP_HYDRATE_CAP = 40;

/**
 * Filter a candidate pool to MPP-capable agents.
 *
 * MPP is only derivable from the detail-only `metadata` field, so filtering it
 * over LIST rows (deriveMpp === false for every one) silently emptied the pool
 * and returned "No matching agents found". Instead: cheaply pre-rank the pool
 * (declared-only), hydrate the top `cap` candidates via getAgent, and filter on
 * the hydrated detail. Bounded so cost stays predictable; if the pool exceeds
 * the cap the tail is left unchecked (logged by the explorer layer).
 */
export async function filterMpp(
  deps: ToolDeps,
  pool: AgentResponse[],
  cap = MPP_HYDRATE_CAP,
): Promise<AgentResponse[]> {
  if (pool.length === 0) return pool;
  const pre = rankAgents(
    pool.map((a) => toRankInput(a)),
    { weights: deps.config.weights, scoreMax: deps.config.scoreMax, sortBy: "relevance" },
  );
  const byId = new Map(pool.map((a) => [a.id, a] as const));
  const head = pre.slice(0, cap).map((r) => byId.get(r.id)!);
  const hydrated = await Promise.all(
    head.map((a) =>
      deps.explorer
        .getAgent(a.id)
        .then((r) => r.data)
        .catch(() => a),
    ),
  );
  return hydrated.filter((a) => deriveCapabilities(a).mpp);
}

// ---------------------------------------------------------------------------
// Server-authored text summaries (TYPED-ONLY interpolation)
// ---------------------------------------------------------------------------

function rowLine(r: RankedRow): string {
  const status = safe(r.verification?.status ?? "unrated");
  return serverText`#${r.rank} agent ${r.id} — ${r.score}/100 (${status})`;
}

/** One-line, name-free summary of a ranked list. */
export function summarizeRanked(rows: RankedRow[]): string {
  if (rows.length === 0) return serverText`No matching agents found.`;
  const head = serverText`${rows.length} agent(s) ranked. `;
  return head + rows.map(rowLine).join("; ") + ".";
}

// ---------------------------------------------------------------------------
// Feedback projection (untrusted → sanitized + labeled)
// ---------------------------------------------------------------------------

export interface SafeFeedbackEntry {
  feedbackIndex: number;
  clientAddress: string;
  value: number | string | null;
  valueDecimals: number | null;
  tag1: string | null;
  tag2: string | null;
  endpoint: string | null;
  feedbackUri: string | null;
  isRevoked: boolean;
  createdAt: string;
  responseCount: number;
}

/** Sanitize one on-chain feedback row (client-authored → untrusted text). */
export function toSafeFeedback(f: FeedbackResponse): SafeFeedbackEntry {
  const sanNull = (v: unknown, cap: number): string | null => {
    if (v == null) return null;
    const s = sanitizeText(v, cap);
    return s.length > 0 ? s : null;
  };
  return {
    feedbackIndex: f.feedbackIndex,
    clientAddress: sanitizeText(f.clientAddress, 60),
    value: typeof f.value === "string" ? sanitizeText(f.value, 60) : f.value,
    valueDecimals: typeof f.valueDecimals === "number" ? f.valueDecimals : null,
    tag1: sanNull(f.tag1, 60),
    tag2: sanNull(f.tag2, 60),
    endpoint: sanNull(f.endpoint, CAPS.serviceEndpoint),
    feedbackUri: sanNull(f.feedbackUri, CAPS.serviceEndpoint),
    isRevoked: Boolean(f.isRevoked),
    createdAt: sanitizeText(f.createdAt, 40),
    responseCount: f.responses?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Handler wrapper — centralizes SDK-error → tool-error mapping
// ---------------------------------------------------------------------------

/**
 * Wrap a tool handler so any thrown SDK/typed error becomes an isError:true
 * tool result (never a hard protocol failure). Zod input-validation errors are
 * handled by the SDK before we run and are intentionally not caught here.
 */
export function handler<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return (await fn(args)) as CallToolResult;
    } catch (err) {
      return mapErrorToToolResult(err) as CallToolResult;
    }
  };
}

/** Re-export so tool files build results without importing types.js directly. */
export { toolResult, mapErrorToToolResult };
export type { ToolResult };
