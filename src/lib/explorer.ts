/**
 * explorer.ts — ExplorerService: a cached, single-flight wrapper over the SDK's
 * `ExplorerClient` (PRIMARY data source).
 *
 * The SDK client already does retries, 429/Retry-After backoff, snake→camel
 * normalization, and typed errors (ApiError/RateLimitError/NotFoundError/
 * ValidationError). We deliberately do NOT re-implement any of that. We add:
 *
 *   (a) a small in-memory TTL cache so repeated tool calls in one chat turn
 *       hit the network once,
 *   (b) keyed single-flight so concurrent identical lookups collapse to one
 *       request, and
 *   (c) `findAgents()` — the correct discovery primitive. The explorer's
 *       `/search` substring-matches poorly and there is NO server-side score
 *       sort (sortBy is only created_at|id), so discovery must fetch via
 *       getAgents({search}) and filter client-side over name/description; the
 *       ranking layer then ranks over the fetched candidates.
 *
 * Errors are NOT swallowed here: the SDK's typed errors propagate unchanged so
 * the tool layer (wrapHandler) maps them via lib/errors.ts. We only use
 * classifyError() to attach a stable code to a debug log line before rethrow.
 */

import {
  ExplorerClient,
  type AgentResponse,
  type ApiResponse,
  type FeedbackResponse,
  type HealthResponse,
  type StatsResponse,
} from "@trionlabs/stellar8004";
import type { Config } from "../config.js";
import { systemClock, type Clock } from "./clock.js";
import { classifyError } from "./errors.js";
import { log, type Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// TTL cache + single-flight (shared with reputation.ts)
// ---------------------------------------------------------------------------

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/** TTL for the effective ttl of a value; a function lets callers vary the TTL
 *  by result (e.g. cache negative/degraded results for a shorter window). */
export type TtlSpec<V> = number | ((value: V) => number);

/**
 * Tiny in-memory TTL cache with keyed single-flight (in-flight promise dedup).
 * Failures are never cached: if the loader throws, the in-flight entry is
 * dropped and the error propagates. Bounded by `maxEntries` (FIFO eviction).
 */
export class TtlCache {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;
  private readonly clock: Clock;

  constructor(opts: { maxEntries?: number; clock?: Clock } = {}) {
    this.maxEntries = opts.maxEntries ?? 500;
    this.clock = opts.clock ?? systemClock;
  }

  /** Get-or-load `key` with single-flight. `ttl` may depend on the value. */
  async wrap<V>(key: string, ttl: TtlSpec<V>, loader: () => Promise<V>): Promise<V> {
    const now = this.clock.now();
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > now) return hit.value as V;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<V>;

    const promise = (async () => {
      try {
        const value = await loader();
        const ttlMs = typeof ttl === "function" ? ttl(value) : ttl;
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise as Promise<V>;
  }

  private set(key: string, value: unknown, ttlMs: number): void {
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: this.clock.now() + Math.max(0, ttlMs) });
  }

  /** Test/utility: drop everything. */
  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }
}

/** Deterministic cache key fragment from params (sorted keys → stable JSON). */
export function stableKey(params: unknown): string {
  if (params == null) return "";
  if (typeof params !== "object") return String(params);
  const obj = params as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    if (obj[k] !== undefined) sorted[k] = obj[k];
  }
  return JSON.stringify(sorted);
}

// ---------------------------------------------------------------------------
// ExplorerService
// ---------------------------------------------------------------------------

/** Cache TTLs (ms) per resource class (modules/01 §2.4.1). */
const TTL = {
  list: 30_000,
  detail: 60_000,
  feedback: 60_000,
  stats: 300_000,
  health: 15_000,
} as const;

/** getAgents() parameters (mirrors the SDK client's supported filter set). */
export type GetAgentsParams = Parameters<ExplorerClient["getAgents"]>[0];
/** getFeedback() parameters. */
export type GetFeedbackParams = Parameters<ExplorerClient["getFeedback"]>[1];
/** search() parameters. */
export type SearchParams = Parameters<ExplorerClient["search"]>[1];

export interface ExplorerServiceOptions {
  clock?: Clock;
  logger?: Logger;
  /** Inject a pre-built client (tests) or a custom fetch. */
  client?: ExplorerClient;
  fetch?: typeof fetch;
  /** HTTP timeout / retry overrides for the underlying client. */
  timeout?: number;
  retries?: number;
  /** Cache size cap. */
  maxCacheEntries?: number;
}

export class ExplorerService {
  private readonly client: ExplorerClient;
  private readonly cache: TtlCache;
  private readonly logger: Logger;

  constructor(cfg: Config, opts: ExplorerServiceOptions = {}) {
    this.logger = (opts.logger ?? log).child({ component: "explorer" });
    this.cache = new TtlCache({
      maxEntries: opts.maxCacheEntries ?? 500,
      clock: opts.clock ?? systemClock,
    });
    this.client =
      opts.client ??
      new ExplorerClient(cfg.explorerBaseUrl, {
        timeout: opts.timeout ?? 10_000,
        retries: opts.retries ?? 3,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
  }

  /** Wrap a loader with logging so SDK typed errors get a stable code, then
   *  rethrow unchanged for the tool layer to map. */
  private async run<V>(key: string, ttl: TtlSpec<V>, loader: () => Promise<V>): Promise<V> {
    try {
      return await this.cache.wrap(key, ttl, loader);
    } catch (err) {
      const body = classifyError(err);
      this.logger.debug("explorer request failed", { key, errorCode: body.code });
      throw err;
    }
  }

  // --- passthrough (cached) reads --------------------------------------------

  getAgents(params: GetAgentsParams = {}): Promise<ApiResponse<AgentResponse[]>> {
    return this.run(`agents:${stableKey(params)}`, TTL.list, () => this.client.getAgents(params));
  }

  getAgent(id: number): Promise<ApiResponse<AgentResponse>> {
    return this.run(`agent:${id}`, TTL.detail, () => this.client.getAgent(id));
  }

  getFeedback(id: number, params?: GetFeedbackParams): Promise<ApiResponse<FeedbackResponse[]>> {
    return this.run(`fb:${id}:${stableKey(params)}`, TTL.feedback, () =>
      this.client.getFeedback(id, params),
    );
  }

  /** Raw explorer full-text search (weak substring match — prefer findAgents). */
  search(q: string, params?: SearchParams): Promise<ApiResponse<AgentResponse[]>> {
    return this.run(`search:${q}:${stableKey(params)}`, TTL.list, () =>
      this.client.search(q, params),
    );
  }

  getStats(): Promise<ApiResponse<StatsResponse>> {
    return this.run("stats", TTL.stats, () => this.client.getStats());
  }

  health(): Promise<ApiResponse<HealthResponse>> {
    return this.run("health", TTL.health, () => this.client.health());
  }

  getAgentsByOwner(address: string): Promise<ApiResponse<AgentResponse[]>> {
    return this.run(`owner:${address}`, TTL.list, () => this.client.getAgentsByAddress(address));
  }

  // --- discovery primitive ---------------------------------------------------

  /**
   * Discovery: fetch candidates via getAgents({search}) then filter
   * client-side over name/description. The explorer's search is a weak
   * substring match and there is no server-side score sort, so this returns a
   * candidate set for the ranking layer to rank; it does NOT rank.
   *
   * - `query`     : free-text; tokenized and matched against name+description.
   * - `filters`   : forwarded getAgents params (x402/trust/minScore/hasServices…).
   * - `match`     : "all" (default) requires every token present; "any" requires one.
   * - `pages`     : how many pages to fetch and concatenate (default 1).
   *
   * Empty/whitespace queries return the fetched page(s) unfiltered.
   */
  async findAgents(
    query: string,
    opts: {
      filters?: Omit<NonNullable<GetAgentsParams>, "search" | "page">;
      match?: "all" | "any";
      pages?: number;
    } = {},
  ): Promise<AgentResponse[]> {
    const filters = opts.filters ?? {};
    const pages = Math.max(1, Math.min(opts.pages ?? 1, 10));
    const q = (query ?? "").trim();

    const collected: AgentResponse[] = [];
    let moreAvailable = false;
    for (let page = 1; page <= pages; page++) {
      // NOTE: we deliberately do NOT forward the free-text query to the explorer's
      // `search=` param. It substring-matches the raw stored name poorly — e.g.
      // "scraper" misses the "Scrapper" agent (CONTEXT §7) — and would hand back an
      // empty server set we could only ever narrow. Fetch by the STRUCTURED filters
      // (x402/trust/minScore/hasServices) only, then stem-match client-side below.
      const params: GetAgentsParams = { ...filters, page };
      const res = await this.getAgents(params);
      const batch = res.data ?? [];
      collected.push(...batch);
      moreAvailable = Boolean(res.meta?.pagination?.hasMore) && batch.length > 0;
      // Stop early when the explorer signals no more pages.
      if (!moreAvailable) break;
    }
    // Legibility for the known scale limit: because there is no server-side text
    // filter, we only ever inspect the first `pages` pages in the explorer's
    // default order. If more pages exist, a matching agent past this window is
    // NOT seen — surface it rather than silently under-returning.
    if (moreAvailable) {
      this.logger.debug("findAgents fetch window exhausted; more pages available (unscanned)", {
        pages,
        scanned: collected.length,
      });
    }

    // De-dupe by id (pages can overlap under concurrent indexer writes).
    const byId = new Map<number, AgentResponse>();
    for (const a of collected) if (!byId.has(a.id)) byId.set(a.id, a);
    const agents = [...byId.values()];

    if (!q) return agents;

    const tokens = tokenize(q);
    if (tokens.length === 0) return agents;
    const mode = opts.match ?? "all";
    // Keep 2-char stems (ai/ml/os/db/3d/io): dropping them made match:"all" stop
    // REQUIRING those tokens, so "ai agent" wrongly matched "Payment Agent".
    // tokenize() already floors at length 2, and stem() leaves short tokens as-is.
    const stems = tokens.map(stem).filter((s) => s.length >= 2);
    const qLower = q.toLowerCase();

    const matchesAgent = (a: AgentResponse, requireAll: boolean): boolean => {
      const svcText = (a.services ?? [])
        .map((s) => `${s?.name ?? ""} ${s?.endpoint ?? ""}`)
        .join(" ");
      const haystack = `${a.name ?? ""} ${a.description ?? ""} ${svcText}`.toLowerCase();
      // Whole-query substring is always a match.
      if (haystack.includes(qLower)) return true;
      if (stems.length === 0) return false;
      // Stem-aware token match so "scraper"/"scraping"/"scrapes" (stem "scrap")
      // all hit the "Scrapper"/"Scrapes" agent, not just the literal spelling.
      const hit = (s: string) => haystack.includes(s);
      return requireAll ? stems.every(hit) : stems.some(hit);
    };

    // Strict (all tokens) first; if that empties the set, relax to any-token so a
    // multi-word query still surfaces the closest agents rather than nothing.
    const strict = agents.filter((a) => matchesAgent(a, mode === "all"));
    if (strict.length > 0 || mode === "any") return strict;
    return agents.filter((a) => matchesAgent(a, false));
  }
}

/** Lowercase word tokens (length ≥ 2) for client-side substring filtering. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Crude English stem: strip a common trailing suffix down to a root of ≥3 chars.
 * Used for substring matching against the RAW haystack, so a stemmed query token
 * ("scrap" from "scraper"/"scraping") still hits an unstemmed on-chain name
 * ("Scrapper", "Scrapes"). Deliberately loose — discovery ranks results after.
 */
export function stem(token: string): string {
  const t = token.toLowerCase();
  for (const suf of ["ping", "ning", "ging", "ing", "pers", "per", "ers", "er", "es", "ed", "s"]) {
    if (t.endsWith(suf) && t.length - suf.length >= 3) return t.slice(0, t.length - suf.length);
  }
  return t;
}
