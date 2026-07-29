/**
 * nlparse.test.ts — the deterministic NL query → structured filter parser
 * (src/lib/nlparse.ts). No LLM, no I/O: pure regex/keyword heuristics, so these
 * are exact behavioural assertions.
 *
 * Trust-boundary relevance: the residual keywords go into the explorer search;
 * the filters drive server-side/client-side selection. Nothing here interpolates
 * agent-authored text — it only parses the USER's own query.
 */

import { describe, it, expect } from "vitest";
import { parseQuery, residualKeywords } from "../src/lib/nlparse.js";

describe("capability triggers", () => {
  it('"scraper that accepts x402" → x402 filter + scraper keyword', () => {
    const q = parseQuery("scraper that accepts x402");
    expect(q.filters.x402).toBe(true);
    expect(q.keywords).toContain("scraper");
    expect(q.keywords).not.toContain("x402"); // trigger token never leaks to search
    expect(q.matched).toContain("x402");
  });

  it('"cheap data agent" → x402 (cheap maps to pay-per-call) + data keyword', () => {
    const q = parseQuery("cheap data agent");
    expect(q.filters.x402).toBe(true);
    expect(q.keywords).toEqual(["data"]);
    expect(q.keywords).not.toContain("cheap");
    expect(q.keywords).not.toContain("agent");
  });

  it('bare "pay" is treated as a payment signal', () => {
    expect(parseQuery("an agent I can pay for rendering").filters.x402).toBe(true);
  });

  it('"streaming payments" → mpp (and x402 from payments)', () => {
    const q = parseQuery("a streaming payments inference agent");
    expect(q.filters.mpp).toBe(true);
    expect(q.filters.x402).toBe(true);
    expect(q.matched).toContain("mpp");
  });

  it('"invocable api endpoint" → hasServices', () => {
    const q = parseQuery("an invocable api endpoint for OCR");
    expect(q.filters.hasServices).toBe(true);
    expect(q.keywords).toContain("ocr");
  });

  it("does not reverse negated capability requests into positive filters", () => {
    const x402 = parseQuery("a scraper without x402");
    expect(x402.filters.x402).toBeUndefined();
    expect(x402.unsupported).toContain("negative-filter:x402");

    const mpp = parseQuery("mpp olmadan çeviri");
    expect(mpp.filters.mpp).toBeUndefined();
    expect(mpp.unsupported).toContain("negative-filter:mpp");
  });
});

describe("trust models (reputation-as-trust needs explicit phrasing)", () => {
  it('"reputation-based oracle" → trust:reputation', () => {
    const q = parseQuery("a reputation-based oracle");
    expect(q.filters.trust).toBe("reputation");
    expect(q.keywords).toContain("oracle");
  });

  it('"good reputation" is a QUALITY phrase, NOT a trust filter', () => {
    const q = parseQuery("a scraper with a good reputation");
    expect(q.filters.trust).toBeUndefined();
    expect(q.filters.minScore).toBe(70); // routed to minScore instead
  });

  it('"validated data provider" → trust:validation', () => {
    expect(parseQuery("a validated data provider").filters.trust).toBe("validation");
  });

  it('"tee attested inference" → trust:tee-attestation', () => {
    expect(parseQuery("tee attested inference").filters.trust).toBe("tee-attestation");
  });
});

describe("score / reputation thresholds", () => {
  it('"most reputable" → implied minScore 70', () => {
    const q = parseQuery("the most reputable scraper");
    expect(q.filters.minScore).toBe(70);
    expect(q.keywords).toContain("scraper");
  });

  it('"top-rated" → implied minScore 80', () => {
    expect(parseQuery("a top-rated translation agent").filters.minScore).toBe(80);
  });

  it('an explicit number wins: "score above 90" → 90', () => {
    expect(parseQuery("an agent with score above 90").filters.minScore).toBe(90);
  });

  it('"above 85" (bare threshold) → 85 and clamps to 0..100', () => {
    expect(parseQuery("a data agent above 85").filters.minScore).toBe(85);
    expect(parseQuery("rated 250").filters.minScore).toBe(100); // clamped
  });

  it("explicit number beats a qualitative phrase in the same query", () => {
    // "top-rated" would imply 80, but the explicit "rated 95" wins.
    expect(parseQuery("top-rated agent rated 95").filters.minScore).toBe(95);
  });
});

describe("compound queries", () => {
  it('"a paid web scraper with a good reputation" → x402 + minScore 70 + [web,scraper]', () => {
    const q = parseQuery("a paid web scraper with a good reputation");
    expect(q.filters).toMatchObject({ x402: true, minScore: 70 });
    expect(q.keywords).toEqual(["web", "scraper"]);
  });

  it("captures every axis at once", () => {
    const q = parseQuery("a reputation-based x402 scraper api rated above 75");
    expect(q.filters).toMatchObject({
      x402: true,
      hasServices: true,
      trust: "reputation",
      minScore: 75,
    });
    expect(q.keywords).toContain("scraper");
  });
});

describe("residual keyword extraction", () => {
  it("drops stopwords, trigger tokens, bare numbers and single letters", () => {
    expect(residualKeywords("find me the best scraper for 3 tasks")).toEqual(["scraper", "tasks"]);
  });

  it("de-dupes while preserving first-seen order", () => {
    expect(residualKeywords("oracle oracle data oracle")).toEqual(["oracle", "data"]);
  });

  it("preserves international words and folds accents deterministically", () => {
    expect(residualKeywords("Türkçe çeviri ve veri")).toEqual(["turkce", "ceviri", "ve", "veri"]);
    expect(residualKeywords("中文 翻译")).toEqual(["中文", "翻译"]);
  });

  it("empty / whitespace / punctuation-only queries yield no keywords and no filters", () => {
    for (const raw of ["", "   ", "!!! ??? ..."]) {
      const q = parseQuery(raw);
      expect(q.keywords).toEqual([]);
      expect(q.filters).toEqual({});
      expect(q.matched).toEqual([]);
      expect(q.unsupported).toEqual([]);
    }
  });

  it("is deterministic", () => {
    const a = parseQuery("a paid reputable web scraper api");
    const b = parseQuery("a paid reputable web scraper api");
    expect(a).toEqual(b);
  });
});
