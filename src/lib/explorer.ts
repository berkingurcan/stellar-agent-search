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
import { classifyError, ExplorerScopeError, UpstreamDataError } from "./errors.js";
import { MAX_AGENT_ID, validWalletOrNull } from "./identifier.js";
import { log, type Logger } from "./logger.js";
import { normalizeSearchText, unicodeTokens } from "./nlparse.js";

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

/**
 * getAgents() parameters.
 *
 * The deployed explorer and the SDK source both support `mpp`, but the exact
 * 0.0.11 declaration published to npm predates that field. The runtime client
 * forwards every supplied parameter, so widen only this local boundary until a
 * release containing the corrected declaration is consumed here.
 */
type SdkGetAgentsParams = NonNullable<Parameters<ExplorerClient["getAgents"]>[0]>;
export type GetAgentsParams = SdkGetAgentsParams & { mpp?: boolean };
/** getFeedback() parameters. */
export type GetFeedbackParams = Parameters<ExplorerClient["getFeedback"]>[1];
/** search() parameters. */
export type SearchParams = Parameters<ExplorerClient["search"]>[1];

/**
 * The live explorer already returns `agentsWithMpp`, while the pinned 0.0.11
 * SDK declaration predates that field. Keep the compatibility widening local
 * to the read boundary; the presentation layer still validates the optional
 * value before exposing it.
 */
export type ExplorerStatsResponse = StatsResponse & { agentsWithMpp?: number };

/** v1 offset pages have no revision token and are not transactional snapshots. */
export const V1_UNVERSIONED_PAGINATION_LIMITATION = "v1-unversioned-offset-pagination";

/** Live v1 identifies only chain/network, not the exact Identity registry contract. */
export const V1_IDENTITY_CONTRACT_UNATTESTED = "v1-identity-contract-unattested";

export interface ExplorerIdentityAttestation {
  status: "authenticated" | "unattested";
  /** Present only when an upstream response supplied and matched the configured contract. */
  identityContract?: string;
  /** Present on v1 responses that expose no exact registry identity. */
  limitation?: typeof V1_IDENTITY_CONTRACT_UNATTESTED;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(path: string, expectation: string): never {
  throw new UpstreamDataError(`Explorer field '${path}' must be ${expectation}.`);
}

function assertOptionalNullableString(row: UnknownRecord, key: string, path: string): void {
  const value = row[key];
  if (value !== undefined && value !== null && typeof value !== "string") {
    malformed(`${path}.${key}`, "a string, null, or absent");
  }
}

function assertOptionalBoolean(row: UnknownRecord, key: string, path: string): void {
  const value = row[key];
  if (value !== undefined && typeof value !== "boolean") {
    malformed(`${path}.${key}`, "a boolean or absent");
  }
}

function assertOptionalFiniteNumber(
  row: UnknownRecord,
  key: string,
  path: string,
  nullable = true,
): void {
  const value = row[key];
  if (value === undefined || (nullable && value === null)) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    malformed(`${path}.${key}`, nullable ? "a finite number, null, or absent" : "a finite number");
  }
}

function assertOptionalCount(row: UnknownRecord, key: string, path: string, nullable = false): void {
  const value = row[key];
  if (value === undefined || (nullable && value === null)) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    malformed(
      `${path}.${key}`,
      nullable ? "a non-negative safe integer, null, or absent" : "a non-negative safe integer or absent",
    );
  }
}

/**
 * Validate one normalized SDK agent row before it enters a cache or adapter.
 * The SDK intentionally normalizes names, but it does not runtime-check row
 * primitives; accepting its TypeScript declaration as proof let values such as
 * `x402Enabled: "false"` become true through JavaScript truthiness.
 */
function assertAgentRow(value: unknown, path: string): asserts value is AgentResponse {
  if (!isRecord(value)) malformed(path, "an object");

  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id < 0 || value.id > MAX_AGENT_ID) {
    malformed(`${path}.id`, "an unsigned 32-bit integer");
  }
  if (
    typeof value.owner !== "string" ||
    value.owner !== value.owner.trim() ||
    validWalletOrNull(value.owner) !== value.owner
  ) {
    malformed(`${path}.owner`, "a checksum-valid Stellar G- or C-address");
  }

  for (const key of ["name", "description", "image", "wallet", "agentUri", "txHash"] as const) {
    assertOptionalNullableString(value, key, path);
  }
  if (value.createdAt !== undefined && typeof value.createdAt !== "string") {
    malformed(`${path}.createdAt`, "a string or absent");
  }
  for (const key of ["x402Enabled", "mppEnabled", "mpp", "hasServices"] as const) {
    assertOptionalBoolean(value, key, path);
  }
  for (const key of ["totalScore", "avgScore"] as const) {
    assertOptionalFiniteNumber(value, key, path);
  }
  for (const key of ["feedbackCount", "uniqueClients"] as const) {
    assertOptionalCount(value, key, path);
  }
  assertOptionalCount(value, "createdLedger", path, true);

  if (value.supportedTrust !== undefined) {
    if (!Array.isArray(value.supportedTrust) || value.supportedTrust.some((item) => typeof item !== "string")) {
      malformed(`${path}.supportedTrust`, "an array of strings or absent");
    }
  }
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata) || Object.values(value.metadata).some((item) => typeof item !== "string")) {
      malformed(`${path}.metadata`, "a string-valued object or absent");
    }
  }
  if (
    value.resolveStatus !== undefined &&
    value.resolveStatus !== "ready" &&
    value.resolveStatus !== "resolving" &&
    value.resolveStatus !== "no-uri"
  ) {
    malformed(`${path}.resolveStatus`, "ready, resolving, no-uri, or absent");
  }

  if (value.scores !== undefined) {
    if (!isRecord(value.scores)) malformed(`${path}.scores`, "an object or absent");
    assertOptionalFiniteNumber(value.scores, "total", `${path}.scores`, false);
    assertOptionalFiniteNumber(value.scores, "average", `${path}.scores`, false);
    assertOptionalCount(value.scores, "feedbackCount", `${path}.scores`);
    assertOptionalCount(value.scores, "uniqueClients", `${path}.scores`);
    for (const key of ["total", "average", "feedbackCount", "uniqueClients"] as const) {
      if (value.scores[key] === undefined) malformed(`${path}.scores.${key}`, "present");
    }
  }

  const feedbackCount = value.scores?.feedbackCount ?? value.feedbackCount;
  const uniqueClients = value.scores?.uniqueClients ?? value.uniqueClients;
  if (
    typeof feedbackCount === "number" &&
    typeof uniqueClients === "number" &&
    uniqueClients > feedbackCount
  ) {
    malformed(`${path}.uniqueClients`, "less than or equal to feedbackCount");
  }
}

function assertPagination(value: unknown): void {
  if (!isRecord(value)) return;
  const meta = value.meta;
  if (!isRecord(meta) || meta.pagination === undefined) return;
  if (!isRecord(meta.pagination)) malformed("meta.pagination", "an object or absent");
  const pagination = meta.pagination;
  for (const key of ["page", "limit", "total"] as const) {
    const item = pagination[key];
    const minimum = key === "page" ? 1 : 0;
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < minimum) {
      malformed(`meta.pagination.${key}`, `a safe integer >= ${minimum}`);
    }
  }
  if (typeof pagination.hasMore !== "boolean") {
    malformed("meta.pagination.hasMore", "a boolean");
  }
}

function assertAgentListResponse(value: unknown, path = "data"): void {
  if (!isRecord(value) || !Array.isArray(value.data)) malformed(path, "an array");
  value.data.forEach((row, index) => assertAgentRow(row, `${path}[${index}]`));
  assertPagination(value);
}

function assertAgentDetailResponse(value: unknown, expectedId: number): void {
  if (!isRecord(value)) malformed("response", "an object");
  assertAgentRow(value.data, "data");
  if (value.data.id !== expectedId) {
    malformed("data.id", "equal to the requested agent id");
  }
}

/** Read only explicit response-level identity fields; agent-authored data never attests registry scope. */
function exposedIdentityContract(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.meta)) return null;
  const candidates: unknown[] = [];
  if (value.meta.identityContract !== undefined) candidates.push(value.meta.identityContract);
  if (value.meta.contracts !== undefined) {
    if (!isRecord(value.meta.contracts)) {
      throw new ExplorerScopeError("Explorer contract metadata is malformed");
    }
    if (value.meta.contracts.identity !== undefined) candidates.push(value.meta.contracts.identity);
  }
  if (candidates.length === 0) return null;
  if (candidates.some((candidate) => typeof candidate !== "string")) {
    throw new ExplorerScopeError("Explorer Identity contract metadata is malformed");
  }
  const identities = new Set(candidates as string[]);
  if (identities.size !== 1) {
    throw new ExplorerScopeError("Explorer Identity contract metadata is contradictory");
  }
  return [...identities][0]!;
}

export interface ExplorerServiceOptions {
  clock?: Clock;
  logger?: Logger;
  /** Share an actor-neutral list/detail cache across request-scoped clients. */
  cache?: TtlCache;
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
  private readonly expectedNetwork: Config["network"];
  private readonly expectedIdentity: string;

  constructor(cfg: Config, opts: ExplorerServiceOptions = {}) {
    this.logger = (opts.logger ?? log).child({ component: "explorer" });
    this.cache =
      opts.cache ??
      new TtlCache({
        maxEntries: opts.maxCacheEntries ?? 500,
        clock: opts.clock ?? systemClock,
      });
    this.expectedNetwork = cfg.network;
    this.expectedIdentity = cfg.stellar.contracts.identity;
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
  private async run<V>(
    key: string,
    ttl: TtlSpec<V>,
    loader: () => Promise<V>,
    validate?: (value: V) => void,
  ): Promise<V> {
    try {
      return await this.cache.wrap(key, ttl, async () => {
        const value = this.assertExplorerScope(await loader());
        validate?.(value);
        return value;
      });
    } catch (err) {
      const body = classifyError(err);
      this.logger.debug("explorer request failed", { key, errorCode: body.code });
      throw err;
    }
  }

  /** Never combine registry rows from one chain with handles/contracts from another. */
  private assertExplorerScope<V>(value: V): V {
    if (typeof value !== "object" || value === null) {
      throw new ExplorerScopeError("Explorer response has no verifiable chain/network metadata");
    }
    const meta = Reflect.get(value, "meta");
    if (typeof meta !== "object" || meta === null) {
      throw new ExplorerScopeError("Explorer response has no verifiable chain/network metadata");
    }
    const chain = Reflect.get(meta, "chain");
    const rawNetwork = Reflect.get(meta, "network");
    const actualNetwork =
      typeof rawNetwork === "string" && rawNetwork.toLowerCase() === "pubnet"
        ? "mainnet"
        : typeof rawNetwork === "string"
          ? rawNetwork.toLowerCase()
          : "";
    if (typeof chain !== "string" || chain.toLowerCase() !== "stellar") {
      throw new ExplorerScopeError(
        `Explorer chain '${String(chain)}' does not match required chain 'stellar'`,
      );
    }
    if (actualNetwork !== this.expectedNetwork) {
      throw new ExplorerScopeError(
        `Explorer network '${String(rawNetwork)}' does not match configured network '${this.expectedNetwork}'`,
      );
    }
    const identityContract = exposedIdentityContract(value);
    if (identityContract !== null && identityContract !== this.expectedIdentity) {
      throw new ExplorerScopeError(
        "Explorer Identity contract does not match the configured registry contract",
      );
    }
    return value;
  }

  /**
   * Exact registry identity is authenticated only when response-level metadata
   * supplies it and it matches the SDK's configured contract. Live v1 omits it,
   * so absence is reported as unattested rather than guessed from the hostname.
   */
  identityAttestation(value: unknown): ExplorerIdentityAttestation {
    const identityContract = exposedIdentityContract(value);
    if (identityContract === null) {
      return {
        status: "unattested",
        limitation: V1_IDENTITY_CONTRACT_UNATTESTED,
      };
    }
    if (identityContract !== this.expectedIdentity) {
      throw new ExplorerScopeError(
        "Explorer Identity contract does not match the configured registry contract",
      );
    }
    return { status: "authenticated", identityContract };
  }

  // --- passthrough (cached) reads --------------------------------------------

  getAgents(params: GetAgentsParams = {}): Promise<ApiResponse<AgentResponse[]>> {
    return this.run(
      `agents:${stableKey(params)}`,
      TTL.list,
      () => this.client.getAgents(params),
      assertAgentListResponse,
    );
  }

  getAgent(id: number): Promise<ApiResponse<AgentResponse>> {
    return this.run(
      `agent:${id}`,
      TTL.detail,
      () => this.client.getAgent(id),
      (value) => assertAgentDetailResponse(value, id),
    );
  }

  getFeedback(id: number, params?: GetFeedbackParams): Promise<ApiResponse<FeedbackResponse[]>> {
    return this.run(`fb:${id}:${stableKey(params)}`, TTL.feedback, () =>
      this.client.getFeedback(id, params),
    );
  }

  /** Raw explorer full-text search (weak substring match — prefer findAgents). */
  search(q: string, params?: SearchParams): Promise<ApiResponse<AgentResponse[]>> {
    return this.run(
      `search:${q}:${stableKey(params)}`,
      TTL.list,
      () => this.client.search(q, params),
      assertAgentListResponse,
    );
  }

  getStats(): Promise<ApiResponse<ExplorerStatsResponse>> {
    return this.run("stats", TTL.stats, () => this.client.getStats());
  }

  health(): Promise<ApiResponse<HealthResponse>> {
    return this.run("health", TTL.health, () => this.client.health());
  }

  getAgentsByOwner(address: string): Promise<ApiResponse<AgentResponse[]>> {
    return this.run(
      `owner:${address}`,
      TTL.list,
      () => this.client.getAgentsByAddress(address),
      (value) => {
        assertAgentListResponse(value);
        for (const [index, row] of value.data.entries()) {
          if (row.owner !== address) malformed(`data[${index}].owner`, "equal to the requested owner");
        }
      },
    );
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
  async findAgentsWithCoverage(
    query: string,
    opts: {
      filters?: Omit<NonNullable<GetAgentsParams>, "search" | "page">;
      match?: "all" | "any";
      pages?: number;
    } = {},
  ): Promise<FindAgentsResult> {
    const filters = opts.filters ?? {};
    const pages = Math.max(1, Math.min(opts.pages ?? 1, 10));
    const q = (query ?? "").trim();

    const collected: AgentResponse[] = [];
    let pagesScanned = 0;
    let hasMore: boolean | undefined;
    for (let page = 1; page <= pages; page++) {
      // NOTE: we deliberately do NOT forward the free-text query to the explorer's
      // `search=` param. It substring-matches the raw stored name poorly — e.g.
      // "scraper" misses the "Scrapper" agent (CONTEXT §7) — and would hand back an
      // empty server set we could only ever narrow. Fetch by the STRUCTURED filters
      // (x402/trust/minScore/hasServices) only, then stem-match client-side below.
      const params: GetAgentsParams = { ...filters, page };
      const res = await this.getAgents(params);
      const batch = res.data ?? [];
      pagesScanned++;
      collected.push(...batch);
      const reportedHasMore = res.meta?.pagination?.hasMore;
      hasMore = typeof reportedHasMore === "boolean" ? reportedHasMore : undefined;
      // Stop when the explorer explicitly reports completion, or when an empty
      // page makes further progress impossible. An empty page with hasMore=true
      // remains incomplete in the coverage result below.
      if (hasMore === false || batch.length === 0) break;
    }
    // Legibility for the known scale limit: because there is no server-side text
    // filter, we only ever inspect the first `pages` pages in the explorer's
    // default order. If more pages exist, a matching agent past this window is
    // NOT seen — surface it rather than silently under-returning.
    if (hasMore === true) {
      this.logger.debug("findAgents fetch window exhausted; more pages available (unscanned)", {
        pages: pagesScanned,
        scanned: collected.length,
      });
    }

    const paginationExhausted = hasMore === false;
    // v1 has no revision token. Even one HTTP response is assembled from
    // independent upstream queries, so hasMore=false proves only pagination
    // exhaustion reported by that response, never a transactional snapshot.
    const snapshotConsistent = false;
    // The v1 Explorer preselects at most 500 ids for minScore before it paginates.
    // hasMore=false therefore proves only that the capped qualifier set ended,
    // not that every matching registry row was visible.
    const qualifierMayBeCapped = typeof filters.minScore === "number" && filters.minScore > 0;
    const limitations = [
      V1_UNVERSIONED_PAGINATION_LIMITATION,
      ...(hasMore === undefined ? ["pagination-metadata-unavailable"] : []),
      ...(qualifierMayBeCapped ? ["v1-minScore-qualifier-cap-500"] : []),
    ];
    const coverage: DiscoveryCoverage = {
      coverageComplete: false,
      paginationExhausted,
      snapshotConsistent,
      pagesScanned,
      recordsScanned: collected.length,
      ...(hasMore !== undefined ? { hasMore } : {}),
      limitations,
    };

    // De-dupe by id (pages can overlap under concurrent indexer writes).
    const byId = new Map<number, AgentResponse>();
    for (const a of collected) if (!byId.has(a.id)) byId.set(a.id, a);
    const agents = [...byId.values()];

    if (!q) return { agents, coverage };

    const tokens = tokenize(q);
    if (tokens.length === 0) {
      return {
        agents: [],
        coverage: {
          ...coverage,
          coverageComplete: false,
          limitations: [...(coverage.limitations ?? []), "query-no-search-tokens"],
        },
      };
    }
    const mode = opts.match ?? "all";
    // Keep 2-char stems (ai/ml/os/db/3d/io): dropping them made match:"all" stop
    // REQUIRING those tokens, so "ai agent" wrongly matched "Payment Agent".
    // tokenize() already floors at length 2, and stem() leaves short tokens as-is.
    const stems = tokens.map(stem).filter((s) => s.length >= 2);
    const qLower = normalizeSearchText(q);

    const matchesAgent = (a: AgentResponse, requireAll: boolean): boolean => {
      const svcText = (a.services ?? [])
        .map((s) => `${s?.name ?? ""} ${s?.endpoint ?? ""}`)
        .join(" ");
      const haystack = normalizeSearchText(
        `${a.name ?? ""} ${a.description ?? ""} ${svcText}`,
      );
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
    if (strict.length > 0 || mode === "any") return { agents: strict, coverage };
    return { agents: agents.filter((a) => matchesAgent(a, false)), coverage };
  }

  /** Backward-compatible discovery helper for callers that only need rows. */
  async findAgents(
    query: string,
    opts: {
      filters?: Omit<NonNullable<GetAgentsParams>, "search" | "page">;
      match?: "all" | "any";
      pages?: number;
    } = {},
  ): Promise<AgentResponse[]> {
    return (await this.findAgentsWithCoverage(query, opts)).agents;
  }
}

/** Honest description of how much of the filtered explorer set was inspected. */
export interface DiscoveryCoverage {
  coverageComplete: boolean;
  /** The final observed page explicitly reported `hasMore=false`. */
  paginationExhausted: boolean;
  /** v1 is always false; true requires a future revision-bound cursor/snapshot. */
  snapshotConsistent: boolean;
  pagesScanned: number;
  recordsScanned: number;
  /** Present only when pagination metadata lets the explorer derive it. */
  hasMore?: boolean;
  /** Known upstream conditions that prevent a completeness claim. */
  limitations?: string[];
}

export interface FindAgentsResult {
  agents: AgentResponse[];
  coverage: DiscoveryCoverage;
}

/** Lowercase word tokens (length ≥ 2) for client-side substring filtering. */
function tokenize(query: string): string[] {
  return unicodeTokens(query).filter((t) => t.length >= 2);
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
