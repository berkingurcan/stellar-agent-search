/**
 * Golden tests for stellar-agent-search-declared-evidence-v1.
 *
 *   q     = clamp(avg / 100, 0, 1), or 0 when unrated
 *   effUc = min(validSafeInt(uniqueClients), validSafeInt(feedbackCount))
 *   effFc = min(feedbackCount, 3 * effUc)
 *   v     = ln1p(effFc) / ln1p(50)
 *   b     = ln1p(effUc) / ln1p(25)
 *   e     = 0.4*v + 0.6*b
 *   score = q*e
 */

import { describe, expect, it } from "vitest";
import {
  breadthNorm,
  clamp,
  qualityNorm,
  rankAgents,
  RANKING,
  scoreAgent,
  volumeNorm,
  type RankInput,
} from "../src/lib/ranking.js";
import { RANK_SCORE_MAX } from "../src/config.js";
import { declaredReputation } from "../src/tools/shared.js";

const NOW = Date.parse("2026-07-01T00:00:00.000Z");
const OPTS = { now: NOW, scoreMax: RANK_SCORE_MAX } as const;

function input(overrides: Partial<RankInput> = {}): RankInput {
  return {
    id: 1,
    avg: 80,
    feedbackCount: 10,
    uniqueClients: 5,
    x402: false,
    mpp: false,
    hasServices: false,
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("pure normalizers", () => {
  it("distinguishes unrated from a zero rating", () => {
    expect(qualityNorm(null, 0)).toBeNull();
    expect(qualityNorm(90, 0)).toBeNull();
    expect(qualityNorm(null, 5)).toBeNull();
    expect(qualityNorm(0, 5)).toBe(0);
  });

  it("normalizes and clamps quality against the local display scale", () => {
    expect(qualityNorm(96.75, 8, 100)).toBeCloseTo(0.9675, 10);
    expect(qualityNorm(150, 3, 100)).toBe(1);
    expect(qualityNorm(-10, 3, 100)).toBe(0);
  });

  it("rejects a score scale that would redefine the versioned v1 policy", () => {
    expect(() => qualityNorm(5, 1, 10)).toThrow(/fixes scoreMax at 100/);
    expect(() => scoreAgent(input(), { ...OPTS, scoreMax: 10 })).toThrow(
      /fixes scoreMax at 100/,
    );
  });

  it("uses the documented log saturation points", () => {
    expect(volumeNorm(0)).toBe(0);
    expect(volumeNorm(RANKING.VOL_SAT)).toBeCloseTo(1, 12);
    expect(breadthNorm(0)).toBe(0);
    expect(breadthNorm(RANKING.BREADTH_SAT)).toBeCloseTo(1, 12);
  });

  it("clamps NaN and out-of-range values", () => {
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
  });
});

describe("Explorer reputation adapter", () => {
  it("fails malformed numeric fields closed before ranking", () => {
    const declared = declaredReputation({
      scores: {
        feedbackCount: Number.POSITIVE_INFINITY,
        uniqueClients: Number.NaN,
        average: Number.POSITIVE_INFINITY,
      },
    } as never);
    expect(declared).toEqual({ average: null, feedbackCount: 0, uniqueClients: 0 });
  });
});

describe("golden high-rated example", () => {
  const example = input({
    id: 10,
    avg: 96.75,
    feedbackCount: 8,
    uniqueClients: 4,
    x402: true,
    hasServices: true,
  });

  it("returns the exact versioned q × evidence breakdown", () => {
    const r = scoreAgent(example, OPTS);
    expect(r.rankVersion).toBe("stellar-agent-search-declared-evidence-v1");
    expect(r.quality.raw).toBe(96.75);
    expect(r.quality.norm).toBeCloseTo(0.9675, 10);
    expect(r.quality.weight).toBe(1);
    expect(r.quality.weighted).toBeCloseTo(0.9675, 10);
    expect(r.effectiveUniqueClients).toBe(4);
    expect(r.effectiveFeedbackCount).toBe(8);
    expect(r.volume.norm).toBeCloseTo(0.5588306254094444, 12);
    expect(r.volume.weight).toBe(0.4);
    expect(r.volume.weighted).toBeCloseTo(0.2235322501637778, 12);
    expect(r.breadth.norm).toBeCloseTo(0.49398103882196526, 12);
    expect(r.breadth.weight).toBe(0.6);
    expect(r.breadth.weighted).toBeCloseTo(0.29638862329317915, 12);
    expect(r.evidenceStrength).toBeCloseTo(0.5199208734569569, 12);
    expect(r.score).toBeCloseTo(0.5030234450696058, 12);
    expect(r.score100).toBe(50);
    expect(r.base).toBe(r.score);
    expect(r.confidence).toBe(r.evidenceStrength);
  });

  it("does not turn declarations or verification state into points", () => {
    const baseline = scoreAgent(example, OPTS);
    for (const candidate of [
      { ...example, x402: false, mpp: false, hasServices: false },
      { ...example, verificationStatus: "verified" as const },
      { ...example, verificationStatus: "mismatch" as const },
    ]) {
      const r = scoreAgent(candidate, OPTS);
      expect(r.score).toBe(baseline.score);
      expect(r.paymentBonus).toBe(0);
      expect(r.endpointBonus).toBe(0);
      expect(r.verifiedBonus).toBe(0);
    }
  });

  it("exposes lowEvidence and its deprecated alias unambiguously", () => {
    expect(scoreAgent(example, OPTS).flags).toEqual({
      unrated: false,
      newAgent: false,
      lowEvidence: false,
      lowConfidence: false,
      verified: false,
      verificationMismatch: false,
    });
  });
});

describe("evidence cannot manufacture quality", () => {
  it("gives no novelty floor to an unrated new agent", () => {
    const r = scoreAgent(
      input({
        id: 99,
        avg: null,
        feedbackCount: 0,
        uniqueClients: 0,
        x402: true,
        hasServices: true,
        createdAt: "2026-06-25T00:00:00.000Z",
      }),
      OPTS,
    );
    expect(r.score).toBe(0);
    expect(r.sortScore).toBe(0);
    expect(r.evidenceStrength).toBe(0);
    expect(r.flags).toMatchObject({ unrated: true, newAgent: true, lowEvidence: true });
  });

  it("keeps a broad zero-rated agent at zero", () => {
    const r = scoreAgent(input({ avg: 0, feedbackCount: 50, uniqueClients: 25 }), OPTS);
    expect(r.evidenceStrength).toBe(1);
    expect(r.score100).toBe(0);
  });

  it("never lets the final score exceed normalized quality", () => {
    for (const candidate of [
      input({ avg: 1, feedbackCount: 1, uniqueClients: 1 }),
      input({ avg: 90, feedbackCount: 40, uniqueClients: 1 }),
      input({ avg: 90, feedbackCount: 40, uniqueClients: 20 }),
    ]) {
      const r = scoreAgent(candidate, OPTS);
      expect(r.score).toBeLessThanOrEqual(r.quality.norm);
    }
  });
});

describe("bounded declared-evidence proxy", () => {
  const repeated = input({ id: 1, avg: 90, feedbackCount: 40, uniqueClients: 1 });
  const broad = input({ id: 2, avg: 90, feedbackCount: 40, uniqueClients: 20 });

  it("caps repeated rows and separates one-client from broad evidence", () => {
    const one = scoreAgent(repeated, OPTS);
    const many = scoreAgent(broad, OPTS);
    expect(one.effectiveFeedbackCount).toBe(3);
    expect(one.evidenceStrength).toBeCloseTo(0.26868077964312354, 12);
    expect(one.score100).toBe(24);
    expect(one.flags.lowEvidence).toBe(true);
    expect(many.effectiveFeedbackCount).toBe(40);
    expect(many.evidenceStrength).toBeCloseTo(0.9384651296727772, 12);
    expect(many.score100).toBe(84);
    expect(many.flags.lowEvidence).toBe(false);
  });

  it("keeps quality independent of breadth", () => {
    expect(scoreAgent(repeated, OPTS).quality.norm).toBe(0.9);
    expect(scoreAgent(broad, OPTS).quality.norm).toBe(0.9);
  });

  it("orders by evidence and supports confidence only as a deprecated alias", () => {
    const evidence = rankAgents([repeated, broad], { ...OPTS, sortBy: "evidence" });
    const legacy = rankAgents([repeated, broad], { ...OPTS, sortBy: "confidence" });
    expect(evidence.map((r) => r.id)).toEqual([2, 1]);
    expect(legacy).toEqual(evidence);
  });
});

describe("malformed aggregate hardening", () => {
  it("cannot buy any evidence with uniqueClients when feedbackCount is zero", () => {
    const r = scoreAgent(input({ avg: null, feedbackCount: 0, uniqueClients: 25 }), OPTS);
    expect(r.breadth.raw).toBe(25);
    expect(r.effectiveUniqueClients).toBe(0);
    expect(r.effectiveFeedbackCount).toBe(0);
    expect(r.evidenceStrength).toBe(0);
    expect(r.score100).toBe(0);
    expect(r.flags).toMatchObject({ unrated: true, lowEvidence: true });
  });

  it("cannot buy breadth with an impossible unique-client tuple", () => {
    const r = scoreAgent(input({ feedbackCount: 1, uniqueClients: 100 }), OPTS);
    expect(r.breadth.raw).toBe(100);
    expect(r.effectiveUniqueClients).toBe(1);
    expect(r.breadth.norm).toBeCloseTo(breadthNorm(1), 12);
    expect(r.flags.lowEvidence).toBe(true);
  });

  it.each([
    [Number.NaN, 4],
    [Number.POSITIVE_INFINITY, 4],
    [-1, 4],
    [1.5, 4],
    [4, Number.NaN],
    [4, Number.POSITIVE_INFINITY],
    [4, -1],
    [4, 1.5],
  ])("fails closed for malformed counts fc=%s uc=%s", (feedbackCount, uniqueClients) => {
    const r = scoreAgent(input({ feedbackCount, uniqueClients }), OPTS);
    expect(Number.isFinite(r.score)).toBe(true);
    expect(Number.isFinite(r.evidenceStrength)).toBe(true);
    if (!Number.isSafeInteger(feedbackCount) || feedbackCount <= 0) {
      expect(r.score100).toBe(0);
      expect(r.effectiveFeedbackCount).toBe(0);
      expect(r.effectiveUniqueClients).toBe(0);
    }
    if (!Number.isSafeInteger(uniqueClients) || uniqueClients <= 0) {
      expect(r.effectiveUniqueClients).toBe(0);
      expect(r.evidenceStrength).toBe(0);
    }
  });
});

describe("ordering and determinism", () => {
  const inputs = [
    input({ id: 1, avg: 90, feedbackCount: 40, uniqueClients: 20 }),
    input({ id: 2, avg: 96.75, feedbackCount: 8, uniqueClients: 4 }),
    input({ id: 3, avg: 90, feedbackCount: 40, uniqueClients: 1 }),
  ];

  it("assigns deterministic 1-based ranks", () => {
    const ranked = rankAgents(inputs, { ...OPTS, sortBy: "score" });
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(ranked.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(rankAgents(inputs, OPTS)).toEqual(rankAgents(inputs, OPTS));
  });

  it("newest is an explicit exploration order", () => {
    const ranked = rankAgents(
      [
        input({ id: 1, createdAt: "2025-01-01T00:00:00Z" }),
        input({ id: 2, createdAt: "2026-01-01T00:00:00Z" }),
        input({ id: 3, createdAt: null }),
      ],
      { ...OPTS, sortBy: "newest" },
    );
    expect(ranked.map((r) => r.id)).toEqual([2, 1, 3]);
  });

  it("breaks exact ties by id", () => {
    const ranked = rankAgents([input({ id: 5 }), input({ id: 2 })], {
      ...OPTS,
      sortBy: "score",
    });
    expect(ranked.map((r) => r.id)).toEqual([2, 5]);
  });
});
