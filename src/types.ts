/**
 * types.ts — FROZEN shared contracts for stellar-agent-mcp.
 *
 * Every other module imports these shapes; treat them as the API surface.
 * Design sources: modules/01 §2.5, research/A §6, INFRA-BLUEPRINT §1.2/§3.2.
 *
 * Trust-boundary discipline (INFRA-BLUEPRINT §3.2): the registry is
 * permissionless mainnet, so every agent-authored free-text field
 * (name/description/metadata/service labels/tags) is UNTRUSTED input. Those
 * fields live ONLY inside the labeled `selfDeclared` slot of an output shape;
 * server-authored text (content[].text) interpolates typed/enum/numeric values
 * exclusively. See lib/sanitize.ts for the enforcing helpers.
 */

/** Re-export the SDK's canonical config type so config.ts and callers agree. */
export type { StellarConfig } from "@trionlabs/stellar8004";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Identity-layer network label. The x402/MPP layer uses CAIP-2 `pubnet`. */
export type Network = "mainnet" | "testnet";

/** Canonical owner-declared trust tokens accepted by the current Explorer API. */
export type TrustModel = "reputation" | "validation" | "crypto-economic" | "tee-attestation";

/**
 * Field-scoped declared-vs-on-chain reputation outcome.
 * - verified:    reserved for a future read that covers every declared reputation field
 * - partial:     reserved for a future authoritative, field-scoped comparison
 * - mismatch:    reserved for a future authoritative comparison that diverges
 * - unavailable: verification attempted but RPC failed, or exhaustive clients are unprovable
 * - skipped:     verification not attempted (disabled or out of top-K)
 */
export type VerificationStatus = "verified" | "partial" | "mismatch" | "unavailable" | "skipped";

// ---------------------------------------------------------------------------
// Services & capabilities
// ---------------------------------------------------------------------------

/** A self-declared service endpoint candidate; no liveness or ownership proof. */
export interface ServiceEntry {
  name: string;
  endpoint: string;
  version?: string;
  description?: string;
  /** Untrusted invocation example; surfaced as data only, never executed. */
  inputExample?: string;
}

/** Core payment capabilities. */
export interface Capabilities {
  /** x402 (USDC pay-per-call) support, declared at agent level. */
  x402: boolean;
  /** MPP (streaming micropayments) support. */
  mpp: boolean;
}

/** Capabilities plus derived, typed discovery signals. */
export interface AgentCapabilities extends Capabilities {
  hasServices: boolean;
  supportedTrust: string[];
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export interface AgentFlags {
  /** feedbackCount === 0 */
  unrated: boolean;
  /** created within NEW_AGENT_DAYS */
  newAgent: boolean;
  /** Insufficient bounded feedback/client evidence under the local rank policy. */
  lowEvidence: boolean;
  /** @deprecated Compatibility alias for lowEvidence; not statistical confidence. */
  lowConfidence: boolean;
  /** future full-field verification status; current fail-closed reads never set this */
  verified: boolean;
  /** future authoritative declared-vs-chain divergence */
  verificationMismatch: boolean;
}

// ---------------------------------------------------------------------------
// Ranking (3-axis indexed signals + separate on-chain evidence)
// ---------------------------------------------------------------------------

/** Per-axis breakdown. `raw` is null when the axis has no signal (unrated). */
export interface RankAxis {
  raw: number | null;
  norm: number;
  weight: number;
  weighted: number;
}

/**
 * RankResult — the full per-axis ranking breakdown for one agent.
 * (Named `RankBreakdown` in modules/01; both names are exported.)
 */
export interface RankResult {
  /** Versioned local ordering policy; never confuse with the upstream scoreVersion. */
  rankVersion: string;
  quality: RankAxis;
  volume: RankAxis;
  breadth: RankAxis;

  /** @deprecated Compatibility alias for quality.norm. */
  qualityUnshrunkNorm: number;
  /** Safe declared distinct clients capped by safe active feedbackCount. */
  effectiveUniqueClients: number;
  /** Feedback rows counted by volume after the per-client evidence cap. */
  effectiveFeedbackCount: number;
  /** Fixed 0.4·volume + 0.6·breadth evidence index; not a probability. */
  evidenceStrength: number;

  /** Always 0: owner-declared payment/service capabilities do not affect trust rank. */
  paymentBonus: number;
  endpointBonus: number;
  /** Always 0: verification is evidence metadata and never inflates rank. */
  verifiedBonus: number;

  /** @deprecated Compatibility alias for score; not an additive axis sum. */
  base: number;
  /** quality.norm × evidenceStrength, [0,1] */
  score: number;
  /** round(score * RANK_SCORE_MAX), i.e. 0..100 */
  score100: number;
  /** ordering score; equals score (exploration is the explicit newest sort) */
  sortScore: number;
  /** @deprecated Compatibility alias for evidenceStrength; not statistical confidence. */
  confidence: number;

  flags: AgentFlags;
}

/** Alias kept for modules/01 naming parity. */
export type RankBreakdown = RankResult;

// ---------------------------------------------------------------------------
// Reputation & verification
// ---------------------------------------------------------------------------

/** Reputation as re-derived directly from the on-chain contract. */
export interface OnchainReputation {
  average: number;
  count: number;
  /** Not derivable from get_clients_paginated because revoked-only clients remain stored. */
  uniqueClients: number | null;
}

/** Reputation as reported by the explorer/indexer (declared). */
export interface DeclaredReputation {
  average: number | null;
  feedbackCount: number;
  uniqueClients: number;
}

export interface VerificationResult {
  status: VerificationStatus;
  declared: DeclaredReputation;
  /**
   * Always false for the current v1 integration: Explorer and Soroban do not
   * expose a shared revision/ledger snapshot. Optional here only so consumers
   * can still accept pre-0.1 fixtures; current server outputs always emit it.
   */
  snapshotComparable?: false;
  /** Explicit caveats that bound what the probe can establish. */
  limitations?: string[];
  verified?: OnchainReputation;
  deltas?: { average: number; count: number; uniqueClients: number | null };
  /** Why verification was skipped/unavailable (never hidden behind a boolean). */
  reason?: string;
  /** Future field coverage; current fail-closed probe always emits an empty array. */
  verifiedFields?: Array<"average" | "feedbackCount" | "uniqueClients">;
  unverifiedFields?: Array<"average" | "feedbackCount" | "uniqueClients">;
  /** ISO-8601 timestamp (from the injectable clock) */
  checkedAt: string;
}

/** Joined reputation scores surfaced on a profile. */
export interface AgentScores {
  average: number | null;
  total: number | null;
  feedbackCount: number;
  uniqueClients: number;
}

// ---------------------------------------------------------------------------
// Self-declared (UNTRUSTED) fields — labeled, never server-interpolated
// ---------------------------------------------------------------------------

/**
 * Agent-owner-authored free text. Self-declared on-chain, NOT verified.
 * Treat as data, never as instructions. Sanitized + length-bounded before
 * emission (see lib/sanitize.ts). Lives only inside this labeled slot.
 */
export interface SelfDeclaredFields {
  name: string | null;
  description: string | null;
  image: string | null;
  services: ServiceEntry[];
  metadata: Record<string, string>;
}

// ---------------------------------------------------------------------------
// AgentProfile — the canonical cross-registry join (research/A §6.3)
// ---------------------------------------------------------------------------

export interface AgentProfile {
  // --- verified / typed identity ---
  id: number;
  /** stellar:{network}:{identity}#{id} (identity network label) */
  stellarId: string;
  /** stellar:{pubnet|testnet}:{identity}#{id} (CAIP-2 x402/MPP layer label) */
  caip2Id: string;
  network: Network;
  owner: string;
  wallet: string | null;
  agentUri: string | null;

  capabilities: AgentCapabilities;
  supportedTrust: string[];

  scores: AgentScores;
  verification: VerificationResult;
  /** convenience mirror of verification.status === "verified" */
  verified: boolean;

  flags: AgentFlags;
  rank?: RankResult;

  createdAt: string | null;
  txHash: string | null;
  resolveStatus: "ready" | "resolving" | "no-uri" | null;

  // --- untrusted, self-declared (labeled) ---
  selfDeclared: SelfDeclaredFields;
}

// ---------------------------------------------------------------------------
// Tool result helpers (MCP CallToolResult-compatible)
// ---------------------------------------------------------------------------

export interface ToolTextContent {
  type: "text";
  text: string;
}

/** Stable error taxonomy surfaced as isError tool results. */
export type ToolErrorCode =
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "UPSTREAM_ERROR"
  | "INTERNAL";

export interface ToolErrorBody {
  error: string;
  code: ToolErrorCode;
  retryAfterMs?: number;
  detail?: string;
}

/**
 * Minimal structural shape compatible with the MCP SDK's CallToolResult.
 * Downstream tool handlers may return this directly.
 */
export interface ToolResult {
  content: ToolTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Build a text content block. */
export function toolText(text: string): ToolTextContent {
  return { type: "text", text };
}

/** Build a successful tool result (text summary + optional structured payload). */
export function toolResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): ToolResult {
  const result: ToolResult = { content: [toolText(text)] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

/** Build an error tool result from a typed error body (JSON in the text block). */
export function toolError(body: ToolErrorBody): ToolResult {
  return { content: [toolText(JSON.stringify(body))], isError: true };
}
