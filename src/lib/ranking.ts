/**
 * ranking.ts — the deterministic declared-reputation ordering heuristic.
 *
 * Local policy version: stellar-agent-market-declared-evidence-v1.
 *
 *   q       = clamp(avg / scoreMax, 0, 1) (0 when unrated)
 *   effUc   = min(validSafeInt(uc), validSafeInt(fc))
 *   b       = clamp(ln1p(effUc) / ln1p(BREADTH_SAT),0,1)
 *   effFc   = min(fc, effUc * MAX_FEEDBACK_PER_CLIENT_EVIDENCE)
 *   v       = clamp(ln1p(effFc) / ln1p(VOL_SAT),0,1)
 *
 *   evidenceStrength = 0.4*v + 0.6*b
 *   score            = q * evidenceStrength
 *
 * Evidence quantity can support an observed rating but can never manufacture
 * positive reputation when q=0. Repeated rows from one address are capped by a
 * deliberately conservative aggregate proxy. This is not per-client
 * winsorization, personhood, or Sybil resistance. x402/MPP/service claims are
 * owner-controlled metadata and never affect the score.
 *
 * `sortScore` intentionally equals `score`. Exploration is an explicit `newest`
 * sort policy, never a hidden trust-order boost for an unrated agent.
 *
 * Every function here is PURE and fully deterministic: given the same inputs
 * (and an explicit `now` for the newAgent flag) it yields byte-identical output.
 */

import type {
  AgentFlags,
  RankAxis,
  RankResult,
  VerificationStatus,
} from "../types.js";
import { RANK_SCORE_MAX } from "../config.js";

// ---------------------------------------------------------------------------
// Tunable constants (modules/01 §3 DEFAULTS). Exported for tests + docs.
// ---------------------------------------------------------------------------

export const RANKING = {
  VERSION: "stellar-agent-market-declared-evidence-v1",
  /** feedbackCount at which the volume axis ≈ 1 (log saturation). */
  VOL_SAT: 50,
  /** uniqueClients at which the breadth axis ≈ 1 (log saturation). */
  BREADTH_SAT: 25,
  /** Retained response constants; owner-declared capabilities never affect score. */
  P_X402: 0,
  P_MPP: 0,
  P_SERVICES: 0,
  /** At most this many feedback rows per distinct client count toward volume. */
  MAX_FEEDBACK_PER_CLIENT_EVIDENCE: 3,
  /** an agent created within this many days is flagged `newAgent`. */
  NEW_AGENT_DAYS: 14,
  /** Both feedback rows and distinct clients must reach this low-evidence floor. */
  MIN_FEEDBACK_FOR_EVIDENCE: 3,
  MIN_UNIQUE_CLIENTS_FOR_EVIDENCE: 3,
  /** Fixed evidence mix. It is an index, not a calibrated probability. */
  EVIDENCE_VOLUME_WEIGHT: 0.4,
  EVIDENCE_BREADTH_WEIGHT: 0.6,
} as const;

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Pure normalization helpers (unit-tested in isolation).
// ---------------------------------------------------------------------------

/** Clamp `x` to the inclusive [lo, hi] range. */
export function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Quality axis, [0,1]. Returns null when the agent is unrated (no feedback or
 * no reported average) so callers can distinguish "no signal" from "scored 0".
 */
export function qualityNorm(
  avg: number | null,
  feedbackCount: number,
  scoreMax: number = RANK_SCORE_MAX,
): number | null {
  if (scoreMax !== RANK_SCORE_MAX) {
    throw new RangeError(
      `${RANKING.VERSION} fixes scoreMax at ${RANK_SCORE_MAX}; received ${String(scoreMax)}`,
    );
  }
  if (feedbackCount <= 0 || avg == null || !Number.isFinite(avg)) return null;
  return clamp(avg / RANK_SCORE_MAX, 0, 1);
}

/** Volume axis, [0,1]. Log-saturating: fc=0→0, fc=VOL_SAT→~1. */
export function volumeNorm(feedbackCount: number): number {
  const fc = feedbackCount > 0 ? feedbackCount : 0;
  return clamp(Math.log1p(fc) / Math.log1p(RANKING.VOL_SAT), 0, 1);
}

/** Breadth / declared Sybil-cost proxy, [0,1]. Log-saturating on unique clients. */
export function breadthNorm(uniqueClients: number): number {
  const uc = uniqueClients > 0 ? uniqueClients : 0;
  return clamp(Math.log1p(uc) / Math.log1p(RANKING.BREADTH_SAT), 0, 1);
}

// ---------------------------------------------------------------------------
// Scoring input / options
// ---------------------------------------------------------------------------

/** Everything the deterministic scorer needs about a single agent. */
export interface RankInput {
  id: number;
  /** declared average feedback value; normalized against local scoreMax policy. */
  avg: number | null;
  feedbackCount: number;
  uniqueClients: number;
  x402: boolean;
  mpp: boolean;
  hasServices: boolean;
  /**
   * Bounded contract-probe outcome. It affects evidence flags only; it never adds
   * to or subtracts from the ranking score. Omitted means not checked.
   */
  verificationStatus?: VerificationStatus;
  /** ISO string or epoch ms; used only for the `newAgent` flag. */
  createdAt?: string | number | null;
}

export interface ScoreOptions {
  /** Compatibility assertion only; v1 rejects every value except RANK_SCORE_MAX. */
  scoreMax?: number;
  /** Epoch ms "now" for the `newAgent` flag. Defaults to Date.now(). */
  now?: number;
}

export type SortMode = "relevance" | "score" | "evidence" | "confidence" | "newest";

export interface RankOptions extends ScoreOptions {
  /** Ordering strategy. Defaults to "relevance" (uses sortScore). */
  sortBy?: SortMode;
}

/** A scored agent plus its 1-based rank position. */
export interface RankedAgent {
  id: number;
  rank: number;
  result: RankResult;
}

// ---------------------------------------------------------------------------
// Core scorer
// ---------------------------------------------------------------------------

function parseCreatedAt(createdAt: string | number | null | undefined): number | null {
  if (createdAt == null) return null;
  if (typeof createdAt === "number") return Number.isFinite(createdAt) ? createdAt : null;
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Deterministically score one agent. Pure: identical `input`/`opts` (including
 * an explicit `now`) always yields identical output.
 */
export function scoreAgent(input: RankInput, opts: ScoreOptions = {}): RankResult {
  const scoreMax = opts.scoreMax ?? RANK_SCORE_MAX;
  if (scoreMax !== RANK_SCORE_MAX) {
    throw new RangeError(
      `${RANKING.VERSION} fixes scoreMax at ${RANK_SCORE_MAX}; received ${String(scoreMax)}`,
    );
  }
  const now = opts.now ?? Date.now();

  const validCount = (value: number): number =>
    Number.isSafeInteger(value) && value > 0 ? value : 0;
  const fc = validCount(input.feedbackCount);
  const declaredUc = validCount(input.uniqueClients);
  // A distinct active client cannot exceed the number of active feedback rows.
  // Preserve the declared raw value below, but never let an impossible tuple buy
  // breadth, quality, volume, or evidence strength.
  const effectiveUniqueClients = Math.min(declaredUc, fc);

  // --- axes ---
  const qn = qualityNorm(input.avg, fc, scoreMax); // null when unrated
  const qNorm = qn ?? 0;
  const bNorm = breadthNorm(effectiveUniqueClients);
  const effectiveFeedbackCount = Math.min(
    fc,
    effectiveUniqueClients * RANKING.MAX_FEEDBACK_PER_CLIENT_EVIDENCE,
  );
  const vNorm = volumeNorm(effectiveFeedbackCount);

  const quality: RankAxis = {
    raw: qn === null ? null : input.avg,
    norm: qNorm,
    weight: 1,
    weighted: qNorm,
  };
  const volume: RankAxis = {
    raw: fc,
    norm: vNorm,
    weight: RANKING.EVIDENCE_VOLUME_WEIGHT,
    weighted: RANKING.EVIDENCE_VOLUME_WEIGHT * vNorm,
  };
  const breadth: RankAxis = {
    raw: declaredUc,
    norm: bNorm,
    weight: RANKING.EVIDENCE_BREADTH_WEIGHT,
    weighted: RANKING.EVIDENCE_BREADTH_WEIGHT * bNorm,
  };

  // Evidence quantity supports quality; it is never reputation by itself.
  const evidenceStrength = clamp(volume.weighted + breadth.weighted, 0, 1);
  // x402, MPP, and service presence are owner-controlled URI declarations.
  // Preserve fields for response compatibility, but never turn claims into trust.
  const paymentBonus = 0;
  const endpointBonus = 0;
  // Kept as an always-zero response field for pre-release schema continuity.
  // Verification is evidence metadata, not a score boost: the current contract
  // cannot re-derive active uniqueClients without an unbounded event scan.
  const verifiedBonus = 0;

  const score = clamp(qNorm * evidenceStrength, 0, 1);
  // Retained compatibility alias. It is the final score, not an additive base.
  const base = score;
  const score100 = Math.round(score * 100);

  // Deprecated compatibility alias; never describe this as a probability.
  const confidence = evidenceStrength;

  // --- flags ---
  const createdMs = parseCreatedAt(input.createdAt);
  const lowEvidence =
    fc < RANKING.MIN_FEEDBACK_FOR_EVIDENCE ||
    effectiveUniqueClients < RANKING.MIN_UNIQUE_CLIENTS_FOR_EVIDENCE;
  const flags: AgentFlags = {
    unrated: fc === 0,
    newAgent: createdMs != null && now - createdMs < RANKING.NEW_AGENT_DAYS * MS_PER_DAY,
    lowEvidence,
    // Deprecated compatibility alias.
    lowConfidence: lowEvidence,
    verified: input.verificationStatus === "verified",
    verificationMismatch: input.verificationStatus === "mismatch",
  };

  // Relevance ordering uses the same declared-reputation heuristic users see.
  const sortScore = score;

  return {
    rankVersion: RANKING.VERSION,
    quality,
    volume,
    breadth,
    qualityUnshrunkNorm: qNorm,
    effectiveUniqueClients,
    effectiveFeedbackCount,
    evidenceStrength,
    paymentBonus,
    endpointBonus,
    verifiedBonus,
    base,
    score,
    score100,
    sortScore,
    confidence,
    flags,
  };
}

/**
 * Round every float in a RankResult to `dp` decimals for clean OUTPUT (avoids
 * 0.4285714285714 spew in structuredContent). Apply only at projection time —
 * internal scoring/sorting uses full precision. score100 is already an integer.
 */
export function roundRankResult(r: RankResult, dp = 4): RankResult {
  const f = (n: number): number => {
    const p = 10 ** dp;
    return Math.round(n * p) / p;
  };
  const ax = (a: RankAxis): RankAxis => ({
    raw: a.raw === null ? null : f(a.raw),
    norm: f(a.norm),
    weight: f(a.weight),
    weighted: f(a.weighted),
  });
  return {
    rankVersion: r.rankVersion,
    quality: ax(r.quality),
    volume: ax(r.volume),
    breadth: ax(r.breadth),
    qualityUnshrunkNorm: f(r.qualityUnshrunkNorm),
    effectiveUniqueClients: r.effectiveUniqueClients,
    effectiveFeedbackCount: r.effectiveFeedbackCount,
    evidenceStrength: f(r.evidenceStrength),
    paymentBonus: f(r.paymentBonus),
    endpointBonus: f(r.endpointBonus),
    verifiedBonus: f(r.verifiedBonus),
    base: f(r.base),
    score: f(r.score),
    score100: r.score100,
    sortScore: f(r.sortScore),
    confidence: f(r.confidence),
    flags: r.flags,
  };
}

// ---------------------------------------------------------------------------
// Ranking (score + stable sort)
// ---------------------------------------------------------------------------

function sortKey(mode: SortMode, r: RankResult): number {
  switch (mode) {
    case "score":
      return r.score;
    case "evidence":
    case "confidence": // deprecated input alias
      return r.evidenceStrength;
    case "newest":
      return 0; // handled separately (needs createdAt)
    case "relevance":
    default:
      return r.sortScore;
  }
}

/**
 * Score every input and return them ranked. Stable: ties break by evidence strength
 * desc, then id asc. `newest` sorts by createdAt desc (missing dates last).
 * Pure and deterministic given an explicit `now`.
 */
export function rankAgents(inputs: RankInput[], opts: RankOptions = {}): RankedAgent[] {
  const mode: SortMode = opts.sortBy ?? "relevance";
  const scored = inputs.map((input) => ({
    input,
    result: scoreAgent(input, opts),
    createdMs: parseCreatedAt(input.createdAt),
  }));

  scored.sort((a, b) => {
    if (mode === "newest") {
      const av = a.createdMs ?? -Infinity;
      const bv = b.createdMs ?? -Infinity;
      if (av !== bv) return bv - av;
    } else {
      const av = sortKey(mode, a.result);
      const bv = sortKey(mode, b.result);
      if (av !== bv) return bv - av;
    }
    // tie-break: evidence strength desc, then id asc (fully deterministic)
    if (a.result.evidenceStrength !== b.result.evidenceStrength) {
      return b.result.evidenceStrength - a.result.evidenceStrength;
    }
    return a.input.id - b.input.id;
  });

  return scored.map((s, i) => ({ id: s.input.id, rank: i + 1, result: s.result }));
}
