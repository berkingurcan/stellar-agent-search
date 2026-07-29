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
import type { CallToolResult } from "@modelcontextprotocol/server";
import type {
  AgentResponse,
  FeedbackResponse,
} from "@trionlabs/stellar8004";
import type { Config } from "../config.js";
import {
  ExplorerService,
  V1_UNVERSIONED_PAGINATION_LIMITATION,
  type ExplorerServiceOptions,
} from "../lib/explorer.js";
import { ReputationVerifier, type ReputationVerifierOptions } from "../lib/reputation.js";
import {
  rankAgents,
  roundRankResult,
  scoreAgent,
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
  sanitizeNullable,
  sanitizeText,
  selfDeclared,
  serverText,
  CAPS,
  type SelfDeclared,
} from "../lib/sanitize.js";
import type {
  AgentCapabilities,
  AgentFlags,
  AgentProfile,
  AgentScores,
  DeclaredReputation,
  Network,
  RankResult,
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
  /** Optional runtime-specific public-surface caps (the local stdio defaults stay broader). */
  policy?: ToolRuntimePolicy;
}

export interface ToolRuntimePolicy {
  maxRankAgentIds?: number;
  maxRankLimit?: number;
  maxListServicesLimit?: number;
  maxListServicesPage?: number;
  maxVerifyTopK?: number;
  maxVerificationConcurrency?: number;
  maxFeedbackScanPages?: number;
  maxExplorerConcurrency?: number;
}

/** Small dependency-free pMap used for bounded Explorer fan-out. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(items.length || 1, Math.floor(limit) || 1)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        output[index] = await mapper(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

/** Construction options for runtime-specific fetch/cache and test seams. */
export interface CreateToolDepsOptions {
  explorer?: ExplorerServiceOptions;
  verifier?: ReputationVerifierOptions;
}

/** Convenience factory: build the read-only deps from a loaded Config. */
export function createToolDeps(config: Config, opts: CreateToolDepsOptions = {}): ToolDeps {
  return {
    config,
    explorer: new ExplorerService(config, opts.explorer),
    verifier: new ReputationVerifier(config, opts.verifier),
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

export const zTrust = z.enum([
  "reputation",
  "crypto-economic",
  "tee-attestation",
  // Backward-compatible MCP aliases; normalize before sending upstream.
  "validation",
  "tee",
]);
export function canonicalTrust(
  value: z.infer<typeof zTrust>,
): "reputation" | "validation" | "crypto-economic" | "tee-attestation" {
  if (value === "tee") return "tee-attestation";
  return value;
}
export const zSort = z.enum(["relevance", "score", "evidence", "confidence", "newest"]);
/** Upstream v1 leaderboard_scores.total_score threshold, not this server's local rank. */
export const zMinExplorerScore = z.number().finite().nonnegative();
/** @deprecated Input shape retained only so handlers can reject it explicitly. */
export const zLegacyMinScore = zMinExplorerScore;
/** Public free-text fields are intentionally small to bound CPU/log/cache-key amplification. */
export const MAX_QUERY_LENGTH = 256;
export const MAX_FEEDBACK_TAG_LENGTH = 64;

export function zLimit(def: number, max = 50) {
  return z.number().int().min(1).max(max).default(def);
}

/** Verification top-K default (bounds on-chain RPC cost). */
export const VERIFY_TOP_K = 5;

// ---------------------------------------------------------------------------
// AgentResponse → typed domain adapters
// ---------------------------------------------------------------------------

/** Best-effort MPP detection for response projection after server-side filtering. */
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
    x402: a.x402Enabled === true,
    mpp: deriveMpp(a),
    hasServices: a.hasServices ?? services.length > 0,
    supportedTrust,
  };
}

/** Reputation as reported by the explorer/indexer (declared). */
export function declaredReputation(a: AgentResponse): DeclaredReputation {
  const safeCount = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const feedbackCount = safeCount(a.scores?.feedbackCount ?? a.feedbackCount ?? 0);
  const rawAvg = a.scores?.average ?? a.avgScore ?? null;
  return {
    average:
      feedbackCount > 0 && typeof rawAvg === "number" && Number.isFinite(rawAvg)
        ? rawAvg
        : null,
    feedbackCount,
    uniqueClients: safeCount(a.scores?.uniqueClients ?? a.uniqueClients ?? 0),
  };
}

/** Joined score summary for a profile. */
export function agentScores(a: AgentResponse): AgentScores {
  const declared = declaredReputation(a);
  const rawTotal = a.scores?.total ?? a.totalScore ?? null;
  return {
    average: declared.average,
    total: typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : null,
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
  /** Versioned local ordering policy. */
  rankVersion: string;
  /** Declared-evidence index in [0,1], not a probability. */
  evidenceStrength: number;
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
  const projectedRank = roundRankResult(result);
  const row: RankedRow = {
    id: a.id,
    rank,
    score: result.score100,
    rankVersion: result.rankVersion,
    evidenceStrength: projectedRank.evidenceStrength,
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
  if (opts.includeBreakdown) row.breakdown = projectedRank;
  if (opts.verification) row.verification = opts.verification;
  return row;
}

// ---------------------------------------------------------------------------
// Canonical single-agent profile join (shared by get_agent_profile,
// get_agent_card, and any tool needing the full cross-registry profile)
// ---------------------------------------------------------------------------

/**
 * Build the canonical {@link AgentProfile} for one agent: typed identity +
 * declared reputation + on-chain reachability evidence + rounded 3-axis rank,
 * with all untrusted free text confined to `selfDeclared` and every typed field
 * (owner/wallet/agentUri/supportedTrust) sanitized or address-validated.
 *
 * Pass `opts.detail` when the caller already fetched the agent (e.g. to fetch it
 * concurrently with feedback) so we don't double-fetch. Degrades closed on
 * verification (status "unavailable"/"skipped") — never throws for that.
 */
export async function buildAgentProfile(
  deps: ToolDeps,
  id: number,
  opts: { verify: boolean; detail?: AgentResponse } = { verify: false },
): Promise<{
  profile: AgentProfile;
  verification: VerificationResult;
  caps: AgentCapabilities;
  declared: DeclaredReputation;
}> {
  const detail = opts.detail ?? (await deps.explorer.getAgent(id)).data;
  const declared = declaredReputation(detail);
  const verification = await deps.verifier.verifyAgainst(id, declared, {
    skip: !opts.verify,
    excludeClient: detail.owner,
  });
  const result = scoreAgent(toRankInput(detail, verification.status), {
    scoreMax: deps.config.scoreMax,
  });
  const ids = agentIds(deps.config, id);
  const caps = deriveCapabilities(detail);

  const profile: AgentProfile = {
    id,
    stellarId: ids.stellarId,
    caip2Id: ids.caip2Id,
    network: deps.config.network,
    owner: sanitizeText(detail.owner, 60),
    wallet: validWalletOrNull(detail.wallet),
    agentUri: sanitizeNullable(detail.agentUri, CAPS.serviceEndpoint),
    capabilities: caps,
    supportedTrust: caps.supportedTrust,
    scores: agentScores(detail),
    verification,
    verified: verification.status === "verified",
    flags: result.flags,
    rank: roundRankResult(result),
    createdAt: detail.createdAt ?? null,
    txHash: detail.txHash ?? null,
    resolveStatus: detail.resolveStatus ?? null,
    selfDeclared: buildSelfDeclaredFields({
      name: detail.name ?? null,
      description: detail.description ?? null,
      image: detail.image ?? null,
      services: detail.services ?? null,
      metadata: detail.metadata ?? null,
    }),
  };
  return { profile, verification, caps, declared };
}

// ---------------------------------------------------------------------------
// Rank + (bounded) on-chain verification pipeline
// ---------------------------------------------------------------------------

export interface RankVerifyOptions {
  sortBy?: SortMode;
  verify: boolean;
  /** How many returned rows receive the bounded contract probe (default VERIFY_TOP_K). */
  verifyTopK?: number;
  /** How many rows to return (post-sort slice). */
  limit: number;
  includeBreakdown?: boolean;
}

/**
 * Rank a candidate set, check the top-K on-chain (bounded), then attach the
 * evidence without inflating score and project trust-boundary-safe rows.
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
  const effectiveVerifyTopK = Math.min(
    verifyTopK,
    deps.policy?.maxVerifyTopK ?? Number.POSITIVE_INFINITY,
  );
  const verifyIds = new Set(returned.slice(0, effectiveVerifyTopK).map((r) => r.id));

  // Probe (or skip) each returned agent. `skip` short-circuits without RPC.
  const verifications = new Map<number, VerificationResult>();
  const pending = [...returned];
  const concurrency = Math.max(
    1,
    Math.min(
      pending.length || 1,
      deps.policy?.maxVerificationConcurrency ?? (pending.length || 1),
    ),
  );
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (pending.length > 0) {
        const r = pending.shift();
        if (!r) return;
      const a = byId.get(r.id)!;
      const skip = !verifyIds.has(r.id);
        const v = await deps.verifier.verifyAgainst(r.id, declaredReputation(a), {
          skip,
          excludeClient: a.owner,
        });
      verifications.set(r.id, v);
      }
    }),
  );

  // Pass 2 — retain deterministic order while attaching verification flags.
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
    isRevoked: f.isRevoked === true,
    createdAt: sanitizeText(f.createdAt, 40),
    responseCount: f.responses?.length ?? 0,
  };
}

export interface FeedbackWindow {
  rows: FeedbackResponse[];
  revokedHidden: number;
  coverage: {
    windowComplete: boolean;
    paginationExhausted: boolean;
    /** Always false for Explorer v1; it supplies no revision-bound snapshot. */
    snapshotConsistent: boolean;
    pagesScanned: number;
    hasMore?: boolean;
    limitations?: string[];
  };
}

/**
 * Build a bounded caller-facing page over the Explorer's fixed-size upstream
 * pages. Revocation filtering happens before the local offset, so page=2,
 * limit=10 means visible rows 11..20 rather than upstream rows 21..30. The
 * upstream uses offset pagination without a revision cursor, so every v1
 * window is explicitly marked snapshot-inconsistent.
 */
export async function collectFeedbackWindow(
  deps: ToolDeps,
  agentId: number,
  options: {
    page: number;
    limit: number;
    tag?: string;
    includeRevoked: boolean;
  },
): Promise<FeedbackWindow> {
  const offset = (options.page - 1) * options.limit;
  const maxPages = Math.max(1, Math.min(deps.policy?.maxFeedbackScanPages ?? 20, 20));
  const rows: FeedbackResponse[] = [];
  let visibleSeen = 0;
  let revokedHidden = 0;
  let pagesScanned = 0;
  let hasMore: boolean | undefined;
  let paginationExhausted = false;
  let paginationContradiction = false;

  for (let upstreamPage = 1; upstreamPage <= maxPages; upstreamPage++) {
    const res = await deps.explorer.getFeedback(
      agentId,
      options.tag ? { page: upstreamPage, tag: options.tag } : { page: upstreamPage },
    );
    pagesScanned++;
    const batch = res.data ?? [];
    const reported = res.meta?.pagination?.hasMore;
    hasMore = typeof reported === "boolean" ? reported : undefined;

    for (const feedback of batch) {
      if (!options.includeRevoked && feedback.isRevoked) {
        revokedHidden++;
        continue;
      }
      if (visibleSeen >= offset && rows.length < options.limit) rows.push(feedback);
      visibleSeen++;
    }

    if (hasMore === false) paginationExhausted = true;
    if (batch.length === 0 && hasMore === true) paginationContradiction = true;
    if (rows.length >= options.limit || paginationExhausted || batch.length === 0) break;
    // Without an explicit continuation signal, do not speculate another page.
    if (hasMore === undefined) break;
  }

  return {
    rows,
    revokedHidden,
    coverage: {
      windowComplete: rows.length >= options.limit || paginationExhausted,
      paginationExhausted,
      snapshotConsistent: false,
      pagesScanned,
      ...(hasMore !== undefined ? { hasMore } : {}),
      limitations: [
        V1_UNVERSIONED_PAGINATION_LIMITATION,
        ...(paginationContradiction ? ["upstream-pagination-contradiction"] : []),
        ...(hasMore === undefined ? ["pagination-metadata-unavailable"] : []),
      ],
    },
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
