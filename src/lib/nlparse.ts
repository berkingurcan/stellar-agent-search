/**
 * nlparse.ts — deterministic natural-language → structured query parser.
 *
 * The MODEL is the LLM in this system; the server stays cheap, predictable and
 * unit-testable. So find_agent's free-text query is parsed here with pure
 * regex/keyword heuristics — NO LLM calls, no I/O, no randomness.
 *
 * A raw query like "a paid web scraper with a good reputation" becomes:
 *   { keywords: ["web", "scraper"],
 *     filters:  { x402: true, minScore: 70 },
 *     matched:  ["x402:paid", "minScore:70"] }
 *
 * Explicit tool arguments always win over these inferred filters (merged by the
 * caller in tools/find_agent.ts) — this parser only proposes.
 */

import type { TrustModel } from "../types.js";

/** Capability / trust / score filters a query may imply. */
export interface ParsedFilters {
  x402?: boolean;
  mpp?: boolean;
  hasServices?: boolean;
  trust?: TrustModel;
  minScore?: number;
}

export interface ParsedQuery {
  /** Residual domain keywords for explorer search (stopwords/triggers removed). */
  keywords: string[];
  filters: ParsedFilters;
  /** Debug trace: which token triggered which filter. */
  matched: string[];
}

// ---------------------------------------------------------------------------
// Lexicon
// ---------------------------------------------------------------------------

/**
 * Words removed from residual keywords: generic English + query framing verbs
 * + every filter-trigger token (so triggers never leak into the search text).
 */
const STOPWORDS = new Set<string>([
  // articles / conjunctions / prepositions
  "a", "an", "the", "and", "or", "of", "to", "for", "with", "without", "in", "on",
  "at", "by", "from", "as", "that", "this", "these", "those", "is", "are", "be",
  "which", "who", "whose", "whom", "it", "its",
  // query framing
  "find", "search", "get", "give", "show", "list", "me", "my", "i", "want",
  "need", "needs", "looking", "look", "please", "some", "any", "an", "agent",
  "agents", "service", "services", "provider", "providers", "one", "ones",
  "using", "use", "uses", "used", "via", "through", "can", "should", "must",
  "supports", "support", "supporting", "has", "have", "having", "offers",
  "offer", "offering", "provides", "provide", "providing", "does", "do",
  // capability triggers
  "x402", "paid", "pay", "payment", "payments", "usdc", "monetized",
  "monetize", "cheap", "cheapest", "affordable", "micropayment", "micropayments",
  "microtransaction", "microtransactions", "mpp", "streaming", "invoke",
  "invocable", "invokable", "callable", "endpoint", "endpoints", "api", "apis",
  // trust triggers
  "reputation", "reputation-based", "validation", "validated", "tee", "enclave",
  "attested", "attestation", "trust", "trusted",
  // score triggers
  "score", "scored", "rated", "rating", "reputable", "highly", "well",
  "reviewed", "review", "reviews", "high", "top", "best", "excellent", "great",
  "good", "quality", "above", "over", "least", "minimum", "min", "than", "more",
]);

// ---------------------------------------------------------------------------
// Regex heuristics
// ---------------------------------------------------------------------------

// Payment / x402. "cheap" & "micropayment" map to x402 per the module spec.
const RE_X402 =
  /\b(x402|paid|pay[- ]?per[- ]?\w+|payments?|usdc|monetiz\w*|cheap\w*|affordable|micropayments?|microtransactions?)\b/;
// Bare "pay" as a whole word (not caught by the pay-per group above).
const RE_PAY = /\bpay\b/;
// MPP / streaming micropayment channel.
const RE_MPP = /\b(mpp|streaming\s+pay\w*|streaming\s+micropayments?|payment\s+streaming)\b/;
// Invokable service endpoints.
const RE_SERVICES = /\b(invoke|invocable|invokable|callable|endpoints?|apis?|service|services)\b/;

// Trust models. Reputation-as-trust needs explicit trust-model phrasing so the
// common "good reputation" (a quality phrase) does NOT become a trust filter.
const RE_TRUST_REPUTATION =
  /\b(reputation[- ]based|reputation\s+trust|trust\s+model\s+reputation|reputation\s+model)\b/;
const RE_TRUST_VALIDATION = /\b(validation|validated|validator[s]?)\b/;
const RE_TRUST_TEE = /\b(tee|enclave|attest\w*)\b/;

// Numeric score: "score/rated/rating ... N" or "above/over/at least N".
const RE_SCORE_NUM = /(?:score|scored|rated|rating)\D{0,12}(\d{1,3})/;
const RE_SCORE_ABOVE = /\b(?:above|over|at\s+least|minimum|min)\s+(\d{1,3})\b/;
// Qualitative reputation phrases → implied minScore.
const RE_SCORE_TOP = /\b(top[- ]?rated|best|excellent|highest[- ]?rated)\b/;
const RE_SCORE_HIGH =
  /\b(highly\s+rated|well[- ]?reviewed|reputable|trusted|good\s+reputation|high\s+reputation|strong\s+reputation|great\s+reputation)\b/;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a natural-language find_agent query into structured filters + residual
 * keywords. Deterministic and side-effect free.
 */
export function parseQuery(raw: string): ParsedQuery {
  const text = (raw ?? "").toLowerCase();
  const filters: ParsedFilters = {};
  const matched: string[] = [];

  // 1. Capabilities
  if (RE_X402.test(text) || RE_PAY.test(text)) {
    filters.x402 = true;
    matched.push("x402");
  }
  if (RE_MPP.test(text)) {
    filters.mpp = true;
    matched.push("mpp");
  }
  if (RE_SERVICES.test(text)) {
    filters.hasServices = true;
    matched.push("hasServices");
  }

  // 2. Trust model (first match wins; validation/tee take a bare keyword,
  //    reputation requires explicit trust-model phrasing).
  if (RE_TRUST_REPUTATION.test(text)) {
    filters.trust = "reputation";
    matched.push("trust:reputation");
  } else if (RE_TRUST_VALIDATION.test(text)) {
    filters.trust = "validation";
    matched.push("trust:validation");
  } else if (RE_TRUST_TEE.test(text)) {
    filters.trust = "tee";
    matched.push("trust:tee");
  }

  // 3. minScore — explicit number wins, then qualitative phrases.
  const numMatch = text.match(RE_SCORE_NUM) ?? text.match(RE_SCORE_ABOVE);
  if (numMatch && numMatch[1] !== undefined) {
    filters.minScore = clampScore(Number(numMatch[1]));
    matched.push(`minScore:${filters.minScore}`);
  } else if (RE_SCORE_TOP.test(text)) {
    filters.minScore = 80;
    matched.push("minScore:80");
  } else if (RE_SCORE_HIGH.test(text)) {
    filters.minScore = 70;
    matched.push("minScore:70");
  }

  // 4. Residual keywords → explorer full-text search.
  const keywords = residualKeywords(text);

  return { keywords, filters, matched };
}

/** Clamp a parsed score to the valid 0..100 integer range. */
function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Split into tokens, drop stopwords + filter-trigger words + bare numbers,
 * keep domain nouns (e.g. "scraper", "oracle", "translation") in order.
 */
export function residualKeywords(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tokenRaw of text.split(/[^a-z0-9]+/)) {
    const token = tokenRaw.trim();
    if (token.length === 0) continue;
    if (/^\d+$/.test(token)) continue; // bare numbers are score args, not keywords
    if (token.length < 2) continue; // single stray letters
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}
