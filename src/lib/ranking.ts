/**
 * ranking.ts — the deterministic 3-axis, on-chain-verifiable ranking engine.
 *
 * Formula frozen by modules/01 §3 + INFRA-BLUEPRINT:
 *
 *   quality = clamp(avg / scoreMax, 0, 1)            (null / 0 when unrated)
 *   volume  = clamp(ln1p(fc) / ln1p(VOL_SAT), 0, 1)  (log-saturating)
 *   breadth = clamp(ln1p(uc) / ln1p(BREADTH_SAT),0,1)(sybil-resistant)
 *
 *   base  = wQ*quality + wV*volume + wB*breadth      (weights sum to 1 ⇒ [0,1])
 *   score = clamp(base + paymentBonus + endpointBonus + verifiedBonus, 0, 1)
 *
 * Default weights 0.5 / 0.2 / 0.3 put breadth (unique clients — hard to fake)
 * above volume (raw count — cheap to fake) for sybil-resistance.
 *
 * Two separated scores:
 *   - `score`     — honest displayed score (unrated ⇒ quality contributes 0).
 *   - `sortScore` — ordering-only, novelty-floored so a capable-but-unrated
 *                   agent is ordered-not-buried, while its displayed score and
 *                   `flags.unrated` stay honest.
 *
 * Every function here is PURE and fully deterministic: given the same inputs
 * (and an explicit `now` for the newAgent flag) it yields byte-identical output.
 */

import type {
  AgentFlags,
  RankAxis,
  RankResult,
  RankWeights,
  VerificationStatus,
} from "../types.js";
import { DEFAULT_WEIGHTS, RANK_SCORE_MAX } from "../config.js";

// ---------------------------------------------------------------------------
// Tunable constants (modules/01 §3 DEFAULTS). Exported for tests + docs.
// ---------------------------------------------------------------------------

export const RANKING = {
  /** feedbackCount at which the volume axis ≈ 1 (log saturation). */
  VOL_SAT: 50,
  /** uniqueClients at which the breadth axis ≈ 1 (log saturation). */
  BREADTH_SAT: 25,
  /** additive bonuses (already scaled into the [0,1] score space). */
  P_X402: 0.05,
  P_MPP: 0.03,
  P_SERVICES: 0.03,
  P_VERIFIED: 0.03,
  /** an agent created within this many days is flagged `newAgent`. */
  NEW_AGENT_DAYS: 14,
  /** feedbackCount below this is flagged `lowConfidence`. */
  MIN_FEEDBACK_FOR_CONFIDENCE: 3,
  /** sort-only floor so capable-but-unrated agents are not buried. */
  NOVELTY_FLOOR: 0.15,
  /** confidence axis mix (evidence proxy, independent of quality). */
  CONF_VOLUME: 0.6,
  CONF_BREADTH: 0.4,
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
  if (feedbackCount <= 0 || avg == null || !Number.isFinite(avg)) return null;
  const max = scoreMax > 0 ? scoreMax : RANK_SCORE_MAX;
  return clamp(avg / max, 0, 1);
}

/** Volume axis, [0,1]. Log-saturating: fc=0→0, fc=VOL_SAT→~1. */
export function volumeNorm(feedbackCount: number): number {
  const fc = feedbackCount > 0 ? feedbackCount : 0;
  return clamp(Math.log1p(fc) / Math.log1p(RANKING.VOL_SAT), 0, 1);
}

/** Breadth / sybil-resistance axis, [0,1]. Log-saturating on unique clients. */
export function breadthNorm(uniqueClients: number): number {
  const uc = uniqueClients > 0 ? uniqueClients : 0;
  return clamp(Math.log1p(uc) / Math.log1p(RANKING.BREADTH_SAT), 0, 1);
}

/** Re-normalize arbitrary non-negative weights so the three sum to 1. */
export function normalizeWeights(w: RankWeights): RankWeights {
  const q = Math.max(0, w.quality);
  const v = Math.max(0, w.volume);
  const b = Math.max(0, w.breadth);
  const sum = q + v + b;
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  return { quality: q / sum, volume: v / sum, breadth: b / sum };
}

// ---------------------------------------------------------------------------
// Scoring input / options
// ---------------------------------------------------------------------------

/** Everything the deterministic scorer needs about a single agent. */
export interface RankInput {
  id: number;
  /** declared average feedback value (0..scoreMax) or null when unrated. */
  avg: number | null;
  feedbackCount: number;
  uniqueClients: number;
  x402: boolean;
  mpp: boolean;
  hasServices: boolean;
  /**
   * Verification outcome. Only "verified" earns the bonus; "mismatch" is a
   * flag with no penalty (modules/01 §3.4). Omitted ⇒ treated as not verified.
   */
  verificationStatus?: VerificationStatus;
  /** ISO string or epoch ms; used only for the `newAgent` flag. */
  createdAt?: string | number | null;
}

export interface ScoreOptions {
  /** Custom weights (re-normalized to sum 1). Defaults to DEFAULT_WEIGHTS. */
  weights?: RankWeights;
  /** Feedback score scale for the quality axis. Defaults to RANK_SCORE_MAX. */
  scoreMax?: number;
  /** Epoch ms "now" for the `newAgent` flag. Defaults to Date.now(). */
  now?: number;
}

export type SortMode = "relevance" | "score" | "confidence" | "newest";

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
  const weights = normalizeWeights(opts.weights ?? DEFAULT_WEIGHTS);
  const scoreMax = opts.scoreMax ?? RANK_SCORE_MAX;
  const now = opts.now ?? Date.now();

  const fc = input.feedbackCount > 0 ? input.feedbackCount : 0;
  const uc = input.uniqueClients > 0 ? input.uniqueClients : 0;

  // --- axes ---
  const qn = qualityNorm(input.avg, fc, scoreMax); // null when unrated
  const qNorm = qn ?? 0; // unrated contributes 0 (honest)
  const vNorm = volumeNorm(fc);
  const bNorm = breadthNorm(uc);

  const quality: RankAxis = {
    raw: qn === null ? null : input.avg,
    norm: qNorm,
    weight: weights.quality,
    weighted: weights.quality * qNorm,
  };
  const volume: RankAxis = {
    raw: fc,
    norm: vNorm,
    weight: weights.volume,
    weighted: weights.volume * vNorm,
  };
  const breadth: RankAxis = {
    raw: uc,
    norm: bNorm,
    weight: weights.breadth,
    weighted: weights.breadth * bNorm,
  };

  // --- weighted base + additive bonuses ---
  const base = clamp(quality.weighted + volume.weighted + breadth.weighted, 0, 1);
  const paymentBonus =
    (input.x402 ? RANKING.P_X402 : 0) + (input.mpp ? RANKING.P_MPP : 0);
  const endpointBonus = input.hasServices ? RANKING.P_SERVICES : 0;
  const verifiedBonus = input.verificationStatus === "verified" ? RANKING.P_VERIFIED : 0;

  const score = clamp(base + paymentBonus + endpointBonus + verifiedBonus, 0, 1);
  const score100 = Math.round(score * 100);

  // --- confidence (evidence proxy, quality-independent) ---
  const confidence = clamp(
    RANKING.CONF_VOLUME * vNorm + RANKING.CONF_BREADTH * bNorm,
    0,
    1,
  );

  // --- flags ---
  const createdMs = parseCreatedAt(input.createdAt);
  const flags: AgentFlags = {
    unrated: fc === 0,
    newAgent: createdMs != null && now - createdMs < RANKING.NEW_AGENT_DAYS * MS_PER_DAY,
    lowConfidence: fc < RANKING.MIN_FEEDBACK_FOR_CONFIDENCE,
    verified: input.verificationStatus === "verified",
    verificationMismatch: input.verificationStatus === "mismatch",
  };

  // --- ordering-only novelty floor (displayed score stays honest) ---
  const sortScore = flags.unrated ? Math.max(score, RANKING.NOVELTY_FLOOR) : score;

  return {
    quality,
    volume,
    breadth,
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

// ---------------------------------------------------------------------------
// Ranking (score + stable sort)
// ---------------------------------------------------------------------------

function sortKey(mode: SortMode, r: RankResult): number {
  switch (mode) {
    case "score":
      return r.score;
    case "confidence":
      return r.confidence;
    case "newest":
      return 0; // handled separately (needs createdAt)
    case "relevance":
    default:
      return r.sortScore;
  }
}

/**
 * Score every input and return them ranked. Stable: ties break by confidence
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
    // tie-break: confidence desc, then id asc (fully deterministic)
    if (a.result.confidence !== b.result.confidence) {
      return b.result.confidence - a.result.confidence;
    }
    return a.input.id - b.input.id;
  });

  return scored.map((s, i) => ({ id: s.input.id, rank: i + 1, result: s.result }));
}
