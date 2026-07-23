/**
 * ranking.test.ts — GOLDEN snapshot tests for the deterministic 3-axis ranking
 * engine (src/lib/ranking.ts). Every expected number here was computed by hand
 * from the frozen formula (modules/01 §3) at RANK_SCORE_MAX = 100:
 *
 *   quality = clamp(avg / 100, 0, 1)              (null when unrated)
 *   volume  = ln1p(fc)      / ln1p(VOL_SAT=50)
 *   breadth = ln1p(uc)      / ln1p(BREADTH_SAT=25)
 *   base    = 0.5*q + 0.2*v + 0.3*b
 *   score   = clamp(base + payment + endpoint + verified bonuses, 0, 1)
 *   score100= round(score * 100)
 *
 * These are golden constants, not a re-implementation: if the formula or a
 * tunable constant changes, these break loudly (as intended).
 */

import { describe, it, expect } from "vitest";
import {
  scoreAgent,
  rankAgents,
  qualityNorm,
  volumeNorm,
  breadthNorm,
  normalizeWeights,
  clamp,
  RANKING,
  type RankInput,
} from "../src/lib/ranking.js";
import { RANK_SCORE_MAX, DEFAULT_WEIGHTS } from "../src/config.js";

// A fixed "now" so the newAgent flag is deterministic. 2026-07-01T00:00:00Z.
const NOW = Date.parse("2026-07-01T00:00:00.000Z");
const OPTS = { now: NOW, scoreMax: RANK_SCORE_MAX } as const;

describe("pure axis normalizers", () => {
  it("quality is null when unrated (no feedback or no average)", () => {
    expect(qualityNorm(null, 0)).toBeNull();
    expect(qualityNorm(90, 0)).toBeNull(); // avg present but zero feedback
    expect(qualityNorm(null, 5)).toBeNull(); // feedback present but no average
  });

  it("quality normalizes against scoreMax=100", () => {
    expect(qualityNorm(96.75, 8, RANK_SCORE_MAX)).toBeCloseTo(0.9675, 10);
    expect(qualityNorm(50, 3, 100)).toBeCloseTo(0.5, 10);
    // above scale clamps to 1
    expect(qualityNorm(150, 3, 100)).toBe(1);
  });

  it("volume is log-saturating: 0 at fc=0, exactly 1 at VOL_SAT", () => {
    expect(volumeNorm(0)).toBe(0);
    expect(volumeNorm(RANKING.VOL_SAT)).toBeCloseTo(1, 12);
    expect(volumeNorm(8)).toBeCloseTo(0.5588306254, 9);
  });

  it("breadth is log-saturating: 0 at uc=0, exactly 1 at BREADTH_SAT", () => {
    expect(breadthNorm(0)).toBe(0);
    expect(breadthNorm(RANKING.BREADTH_SAT)).toBeCloseTo(1, 12);
    expect(breadthNorm(4)).toBeCloseTo(0.4939810388, 9);
  });

  it("clamp handles NaN by returning the low bound", () => {
    expect(clamp(NaN, 0, 1)).toBe(0);
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
  });

  it("normalizeWeights renormalizes to sum 1 and falls back on all-zero", () => {
    const w = normalizeWeights({ quality: 2, volume: 1, breadth: 1 });
    expect(w.quality + w.volume + w.breadth).toBeCloseTo(1, 12);
    expect(w.quality).toBeCloseTo(0.5, 12);
    expect(normalizeWeights({ quality: 0, volume: 0, breadth: 0 })).toEqual(DEFAULT_WEIGHTS);
  });
});

describe("GOLDEN: Scrapper-like high-reputation agent (avg 96.75, 8 fb, 4 uc)", () => {
  const input: RankInput = {
    id: 10,
    avg: 96.75,
    feedbackCount: 8,
    uniqueClients: 4,
    x402: true,
    mpp: false,
    hasServices: true,
    createdAt: "2025-01-01T00:00:00.000Z", // old ⇒ not newAgent
  };

  it("produces the exact golden breakdown", () => {
    const r = scoreAgent(input, OPTS);
    expect(r.quality.raw).toBe(96.75);
    expect(r.quality.norm).toBeCloseTo(0.9675, 10);
    expect(r.volume.raw).toBe(8);
    expect(r.volume.norm).toBeCloseTo(0.5588306254, 9);
    expect(r.breadth.raw).toBe(4);
    expect(r.breadth.norm).toBeCloseTo(0.4939810388, 9);
    expect(r.paymentBonus).toBe(RANKING.P_X402); // x402 only
    expect(r.endpointBonus).toBe(RANKING.P_SERVICES);
    expect(r.verifiedBonus).toBe(0);
    expect(r.base).toBeCloseTo(0.74371, 5);
    expect(r.score).toBeCloseTo(0.82371, 5);
    expect(r.score100).toBe(82);
    expect(r.confidence).toBeCloseTo(0.532891, 5);
  });

  it("is well clear of the mid-range: a strong agent scores high", () => {
    expect(scoreAgent(input, OPTS).score100).toBeGreaterThanOrEqual(80);
  });

  it("flags are honest: rated, confident, not new", () => {
    const r = scoreAgent(input, OPTS);
    expect(r.flags).toEqual({
      unrated: false,
      newAgent: false,
      lowConfidence: false,
      verified: false,
      verificationMismatch: false,
    });
  });

  it("the verified bonus adds exactly P_VERIFIED (82 → 85)", () => {
    const r = scoreAgent({ ...input, verificationStatus: "verified" }, OPTS);
    expect(r.verifiedBonus).toBe(RANKING.P_VERIFIED);
    expect(r.score100).toBe(85);
    expect(r.flags.verified).toBe(true);
  });

  it("a mismatch is a flag only — no bonus, no penalty", () => {
    const r = scoreAgent({ ...input, verificationStatus: "mismatch" }, OPTS);
    expect(r.verifiedBonus).toBe(0);
    expect(r.score100).toBe(82); // identical to the unverified score
    expect(r.flags.verificationMismatch).toBe(true);
  });
});

describe("GOLDEN: unrated agent is flagged but NOT buried", () => {
  const unrated: RankInput = {
    id: 99,
    avg: null,
    feedbackCount: 0,
    uniqueClients: 0,
    x402: true,
    mpp: false,
    hasServices: true,
    createdAt: "2026-06-25T00:00:00.000Z", // within NEW_AGENT_DAYS of NOW
  };
  // A genuinely poor but rated agent that the unrated one should still out-rank.
  const badRated: RankInput = {
    id: 7,
    avg: 1,
    feedbackCount: 1,
    uniqueClients: 1,
    x402: false,
    mpp: false,
    hasServices: false,
    createdAt: "2025-01-01T00:00:00.000Z",
  };

  it("displayed score stays honest (quality contributes 0)", () => {
    const r = scoreAgent(unrated, OPTS);
    expect(r.quality.raw).toBeNull();
    expect(r.quality.norm).toBe(0);
    expect(r.score100).toBe(8); // only the capability bonuses
    expect(r.flags.unrated).toBe(true);
    expect(r.flags.lowConfidence).toBe(true);
    expect(r.flags.newAgent).toBe(true);
  });

  it("sortScore is novelty-floored to NOVELTY_FLOOR while score is not", () => {
    const r = scoreAgent(unrated, OPTS);
    expect(r.sortScore).toBeCloseTo(RANKING.NOVELTY_FLOOR, 12);
    expect(r.sortScore).toBeGreaterThan(r.score);
  });

  it("ranks ABOVE a rated-but-terrible agent despite a lower displayed score", () => {
    const [first, second] = rankAgents([badRated, unrated], OPTS);
    expect(first.id).toBe(99); // unrated, floored to 0.15
    expect(second.id).toBe(7); // rated but score ~0.104 < 0.15
    // ...and honesty is preserved: the #1 row's displayed score is the lower one.
    expect(first.result.score100).toBe(8);
    expect(second.result.score100).toBe(10);
    expect(first.result.score100).toBeLessThan(second.result.score100);
  });
});

describe("GOLDEN: sybil resistance — breadth outweighs raw volume", () => {
  const base = { avg: 90, feedbackCount: 40, x402: false, mpp: false, hasServices: false } as const;
  // Same average + same feedback count; only the unique-client breadth differs.
  const sybil: RankInput = { id: 1, uniqueClients: 1, ...base }; // 40 fb from ONE client
  const broad: RankInput = { id: 2, uniqueClients: 20, ...base }; // 40 fb from 20 clients

  it("the sybil agent scores materially lower (70 vs 92)", () => {
    const s = scoreAgent(sybil, OPTS);
    const b = scoreAgent(broad, OPTS);
    expect(s.score100).toBe(70);
    expect(b.score100).toBe(92);
    expect(b.score100 - s.score100).toBeGreaterThanOrEqual(20);
  });

  it("volume axis is identical; only breadth separates them", () => {
    const s = scoreAgent(sybil, OPTS);
    const b = scoreAgent(broad, OPTS);
    expect(s.volume.norm).toBeCloseTo(b.volume.norm, 12);
    expect(b.breadth.norm).toBeGreaterThan(s.breadth.norm);
  });

  it("ranking orders the broad agent first under every score-based mode", () => {
    for (const sortBy of ["relevance", "score", "confidence"] as const) {
      const ranked = rankAgents([sybil, broad], { ...OPTS, sortBy });
      expect(ranked[0].id).toBe(2);
      expect(ranked[0].rank).toBe(1);
    }
  });
});

describe("ranking ordering + determinism", () => {
  const inputs: RankInput[] = [
    { id: 1, avg: 90, feedbackCount: 40, uniqueClients: 20, x402: false, mpp: false, hasServices: false },
    { id: 2, avg: 96.75, feedbackCount: 8, uniqueClients: 4, x402: true, mpp: false, hasServices: true },
    { id: 3, avg: 90, feedbackCount: 40, uniqueClients: 1, x402: false, mpp: false, hasServices: false },
  ];

  it("assigns dense 1-based ranks in sorted order", () => {
    const ranked = rankAgents(inputs, { ...OPTS, sortBy: "score" });
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    // broad(92) > scrapper(82) > sybil(70)
    expect(ranked.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("is fully deterministic given an explicit now", () => {
    const a = rankAgents(inputs, OPTS);
    const b = rankAgents(inputs, OPTS);
    expect(a).toEqual(b);
    expect(scoreAgent(inputs[1], OPTS)).toEqual(scoreAgent(inputs[1], OPTS));
  });

  it("newest sorts by createdAt desc, missing dates last", () => {
    const withDates: RankInput[] = [
      { ...inputs[0], id: 1, createdAt: "2025-01-01T00:00:00Z" },
      { ...inputs[1], id: 2, createdAt: "2026-01-01T00:00:00Z" },
      { ...inputs[2], id: 3, createdAt: null },
    ];
    const ranked = rankAgents(withDates, { ...OPTS, sortBy: "newest" });
    expect(ranked.map((r) => r.id)).toEqual([2, 1, 3]);
  });

  it("ties break by confidence desc then id asc", () => {
    // Two identical agents ⇒ same score/confidence ⇒ id asc decides.
    const twins: RankInput[] = [
      { id: 5, avg: 80, feedbackCount: 10, uniqueClients: 5, x402: false, mpp: false, hasServices: false },
      { id: 2, avg: 80, feedbackCount: 10, uniqueClients: 5, x402: false, mpp: false, hasServices: false },
    ];
    const ranked = rankAgents(twins, { ...OPTS, sortBy: "score" });
    expect(ranked.map((r) => r.id)).toEqual([2, 5]);
  });
});
