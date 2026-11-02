/**
 * registry-source.ts — RegistryService: discovery straight from the Identity
 * contract, for networks without an indexer (testnet today).
 *
 * Which agents lists and searches read (the scope):
 *   - newest: the newest agents the contract registered, at most
 *     REGISTRY_SCAN_LIMIT (50 by default; testnet's default source). The
 *     contract assigns ids in order from 0 and has no burn, so `total_agents`
 *     names the window: ids total−N … total−1, newest first.
 *   - allowlist: the agents the operator names in REGISTRY_AGENT_IDS.
 *
 * For each agent the service reads `agent_uri`, `get_agent_wallet` and
 * `find_owner` — simulations on the fetch-only transport in soroban.ts, no key
 * and no transaction — then decodes the registration file the URI points at (a
 * `data:` URI, or an `https:` URL on a public host) into the same AgentResponse
 * row the explorer returns. Every adapter downstream (capabilities,
 * self-declared slots, ranking, the AgentProfile join) therefore runs unchanged.
 *
 * Searches match the registration's name, description and service entries
 * (text-match.ts). When a registration names a Provider Standard manifest and
 * the row does not already match, a search also matches the services that
 * manifest lists, if it is bound to the agent (ProviderManifestService
 * .searchServices): at most MAX_SEARCH_MANIFESTS manifests per search, newest
 * agents first, MANIFEST_CONCURRENCY at a time. A manifest it needed but could
 * not read is named in coverage, never treated as a non-match in silence.
 *
 * What it cannot know, it does not invent:
 *   - A scan covers its window and an allowlist covers itself; neither is the
 *     registry. Coverage says which, how many agents exist (a scan's
 *     registryAgentCount), and names every agent it could not read.
 *   - There is no indexed reputation, so rows carry no scores. Results attach a
 *     `source` note that says scores and feedback counts are not measured.
 *   - Feedback, stats, health and owner lookups are not on this class at all
 *     (see source.ts), and a minScore filter is refused rather than ignored.
 *     (Tools drop a threshold implied by a word like "best" before it gets
 *     here, and say so: see queryMinScore in tools/shared.ts.)
 *
 * Registration files are read with no redirects, a timeout and a size cap, and
 * an `https:` URL that names a local or private host is refused before any
 * request (http.ts), because any registrant chooses it. In allowlist mode only
 * allowlisted agents are read; in a scan any registered agent can be read by id.
 * The contract and file reads are also exported (readIdentity, readRegistration):
 * provider-manifest.ts uses them in explorer mode to check a manifest's binding
 * to its registration [I1]–[I3] on chain rather than trust the indexer for it.
 */

import { NotFoundError, type AgentResponse, type ServiceEntry } from "@trionlabs/stellar8004";
import type { Config } from "../config.js";
import { systemClock, type Clock } from "./clock.js";
import { createLimiter, mapWithConcurrency } from "./concurrency.js";
import { IndexerRequiredError, RegistrationUnreadableError, RegistryReadError } from "./errors.js";
import {
  TtlCache,
  type DiscoveryCoverage,
  type FindAgentsOptions,
  type FindAgentsResult,
  type GetAgentsParams,
} from "./explorer.js";
import { publicHttpsUrlProblem, readCappedText, URL_PROBLEM_MESSAGES } from "./http.js";
import { MAX_AGENT_ID, validWalletOrNull } from "./identifier.js";
import { log, type Logger } from "./logger.js";
import type { ManifestSearchResult } from "./provider-manifest.js";
import { findManifestDeclaration } from "./provider-standard.js";
import { createIdentityReadClient, type IdentityReadClient, type RegistryReadClient } from "./soroban.js";
import type {
  AgentListPage,
  ListAgentsParams,
  RegistrySource,
  RegistrySourceNote,
} from "./source.js";
import { queryStems, registrationHits, selectMatches, type MatchMode, type RowHits } from "./text-match.js";

/** Coverage limitation: the scan saw the operator's allowlist, not the registry. */
export const REGISTRY_ALLOWLIST_LIMITATION = "registry-allowlist-only";
/** Coverage limitation: the scan read the newest agents; older ones exist and were not read. */
export const REGISTRY_NEWEST_LIMITATION = "registry-newest-agents-only";
/** Coverage limitation: no indexer, so reputation was not read. */
export const REGISTRY_REPUTATION_LIMITATION = "registry-reputation-not-indexed";
/** Coverage limitation: some agents in scope failed to read (see unreadableAgentIds). */
export const REGISTRY_UNREADABLE_LIMITATION = "registry-agents-unreadable";
/** Coverage limitation: a search needed manifests it did not read (see unsearchedManifestAgentIds). */
export const MANIFESTS_NOT_SEARCHED_LIMITATION = "provider-manifests-not-searched";

/** Most Provider Standard manifests one search reads. */
export const MAX_SEARCH_MANIFESTS = 10;
/** Manifests a search fetches at once. */
const MANIFEST_CONCURRENCY = 4;

const ALLOWLIST_NOTE =
  "Registry mode: agents come from the operator's allowlist (REGISTRY_AGENT_IDS), read directly from the " +
  "Identity contract. There is no indexer, so reputation is not measured: scores, feedback counts and the " +
  "unrated flag reflect missing data, not an agent without feedback.";

function newestNote(limit: number): string {
  return (
    `Registry mode: lists and searches read the newest ${limit} agents registered on the Identity contract, ` +
    "straight from the chain; older agents are not searched (coverage.registryAgentCount says how many exist). " +
    "Any registered agent can still be read by id. There is no indexer, so reputation is not measured: scores, " +
    "feedback counts and the unrated flag reflect missing data, not an agent without feedback."
  );
}

/** Same freshness as an explorer detail read. An unreadable registration is retried no sooner either. */
const TTL_AGENT_MS = 60_000;
/** How long the agent count stands, as long as an explorer list page. */
const TTL_COUNT_MS = 30_000;
/**
 * Agents read at once. Most of the time goes to registration hosts, some slow
 * (on testnet one host serves most files at ~4 s each), so a full window reads
 * in one round. Their contract simulations still pass the RPC_CONCURRENCY gate.
 */
const READ_CONCURRENCY = 32;
/** Agents whose three Identity simulations run at once, so the RPC sees a bounded load. */
const RPC_CONCURRENCY = 6;
const REGISTRATION_TIMEOUT_MS = 10_000;
/** The contract stores URIs up to 8 KiB; a hosted file gets more room, but not unbounded. */
const MAX_REGISTRATION_BYTES = 64 * 1024;
/** Longest agent URI the contract stores. */
const MAX_AGENT_URI_LENGTH = 8 * 1024;

/** The manifest reads a search makes; ProviderManifestService implements it. */
export interface ManifestSearchReader {
  searchServices(row: AgentResponse): Promise<ManifestSearchResult>;
}

export interface RegistryServiceOptions {
  clock?: Clock;
  logger?: Logger;
  /** Share per-agent reads across request-scoped instances. */
  cache?: TtlCache;
  /** Inject the Identity reader (tests). */
  client?: RegistryReadClient;
  /** Fetch for `https:` registration files (tests, or a runtime-specific fetch). */
  fetch?: typeof fetch;
  maxCacheEntries?: number;
  /**
   * Provider Standard manifests for searches (createToolDeps passes its
   * ProviderManifestService, so the manifest cache is shared). Without it,
   * searches match registrations only.
   */
  manifests?: ManifestSearchReader;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Scope =
  | { kind: "allowlist"; ids: readonly number[]; allowed: ReadonlySet<number> }
  | { kind: "newest"; limit: number };

/** The agents in scope that were read, and how the scope was drawn. */
interface ScopeRead {
  /** In scope order: the allowlist by id, a scan newest first. */
  agents: AgentResponse[];
  /** Ids that could not be read, ascending. */
  unreadable: number[];
  /** Scan: the contract's agent count, and the oldest id in the window. */
  total?: number;
  start?: number;
}

/** A cached agent read: the row, or why its registration file could not be read. */
type AgentRead = { ok: true; row: AgentResponse } | { ok: false; error: RegistrationUnreadableError };

export class RegistryService implements RegistrySource {
  readonly kind = "registry" as const;
  private readonly scope: Scope;
  private readonly client: RegistryReadClient;
  private readonly fetcher: typeof fetch;
  private readonly cache: TtlCache;
  private readonly logger: Logger;
  private readonly manifests: ManifestSearchReader | undefined;
  private readonly rpc = createLimiter(RPC_CONCURRENCY);

  constructor(cfg: Config, opts: RegistryServiceOptions = {}) {
    if (cfg.registryAgentIds) {
      const ids = [...cfg.registryAgentIds].sort((a, b) => a - b);
      this.scope = { kind: "allowlist", ids, allowed: new Set(ids) };
    } else if (cfg.registryScanLimit !== null) {
      this.scope = { kind: "newest", limit: cfg.registryScanLimit };
    } else {
      throw new Error("RegistryService needs config.registryAgentIds or config.registryScanLimit");
    }
    this.client =
      opts.client ??
      createIdentityReadClient(cfg, cfg.simSource ? { simSource: cfg.simSource } : {});
    this.fetcher = opts.fetch ?? ((input, init) => fetch(input, init));
    this.cache =
      opts.cache ??
      new TtlCache({ maxEntries: opts.maxCacheEntries ?? 200, clock: opts.clock ?? systemClock });
    this.logger = (opts.logger ?? log).child({ component: "registry" });
    this.manifests = opts.manifests;
  }

  describe(): RegistrySourceNote {
    return this.scope.kind === "allowlist"
      ? {
          kind: "registry",
          scope: "allowlist",
          allowlistSize: this.scope.ids.length,
          reputationIndexed: false,
          note: ALLOWLIST_NOTE,
        }
      : {
          kind: "registry",
          scope: "newest",
          allowlistSize: this.scope.limit,
          reputationIndexed: false,
          note: newestNote(this.scope.limit),
        };
  }

  /**
   * One agent. An allowlist reads only its own ids. A scan reads any registered
   * agent: the window bounds what lists and searches enumerate, not a lookup.
   */
  async getAgent(id: number): Promise<{ data: AgentResponse }> {
    if (this.scope.kind === "allowlist" && !this.scope.allowed.has(id)) {
      throw new NotFoundError(`agent ${id} (registry mode reads only REGISTRY_AGENT_IDS)`);
    }
    return { data: await this.readAgent(id) };
  }

  /** The scope in its own order (allowlist by id, scan newest first), filtered, one page at a time. */
  async listAgents(params: ListAgentsParams): Promise<AgentListPage> {
    assertNoScoreFilter(params.minScore);
    const read = await this.readScope();
    const matching = read.agents.filter((a) => matchesFilters(a, params));
    const offset = (params.page - 1) * params.limit;
    const page = matching.slice(offset, offset + params.limit);
    const hasMore = offset + params.limit < matching.length;
    return {
      agents: page,
      pagination: {
        page: params.page,
        limit: params.limit,
        // Past the window, how many agents would match is unknown.
        total: olderAgentsExist(read) ? null : matching.length,
        hasMore,
      },
      coverage: this.coverage(read, hasMore),
    };
  }

  /** Every agent in scope matching the filters and the query; `pages` does not apply. */
  async findAgentsWithCoverage(
    query: string,
    opts: FindAgentsOptions = {},
  ): Promise<FindAgentsResult> {
    const filters = opts.filters ?? {};
    assertNoScoreFilter(filters.minScore);
    const read = await this.readScope();
    const candidates = read.agents.filter((a) => matchesFilters(a, filters));
    const coverage = this.coverage(read, false);

    const stems = queryStems(query ?? "");
    if (stems === null) {
      return {
        agents: [],
        coverage: { ...coverage, limitations: [...coverage.limitations!, "query-no-search-tokens"] },
      };
    }
    if (stems.length === 0) return { agents: candidates, coverage };

    const mode = opts.match ?? "all";
    const hits = new Map(candidates.map((a) => [a, registrationHits(a, stems)] as const));
    const unsearched =
      opts.matchManifests === false || this.manifests === undefined
        ? []
        : await this.matchManifests(this.manifests, candidates, hits, mode);
    const { agents, matches } = selectMatches(candidates, hits, mode);
    if (unsearched.length === 0) return { agents, coverage, matches };
    return {
      agents,
      matches,
      coverage: {
        ...coverage,
        limitations: [...coverage.limitations!, MANIFESTS_NOT_SEARCHED_LIMITATION],
        unsearchedManifestAgentIds: unsearched,
      },
    };
  }

  /**
   * Add the services of bound manifests to the rows that need them: rows that
   * name a Provider Standard manifest and do not already match on their
   * registration. Newest agents first, at most MAX_SEARCH_MANIFESTS. Returns the
   * ids whose manifest was needed but not read, ascending.
   */
  private async matchManifests(
    reader: ManifestSearchReader,
    rows: readonly AgentResponse[],
    hits: ReadonlyMap<AgentResponse, RowHits>,
    mode: MatchMode,
  ): Promise<number[]> {
    const needed = rows
      .filter((a) => !hits.get(a)!.satisfies(mode) && findManifestDeclaration(a.services).kind === "declared")
      .sort((x, y) => y.id - x.id);
    const reading = needed.slice(0, MAX_SEARCH_MANIFESTS);
    const unsearched = needed.slice(MAX_SEARCH_MANIFESTS).map((a) => a.id);
    const results = await mapWithConcurrency(reading, MANIFEST_CONCURRENCY, (a) =>
      reader.searchServices(a).catch((): ManifestSearchResult => ({ status: "unavailable" })),
    );
    reading.forEach((a, i) => {
      const result = results[i]!;
      if (result.status === "ok") {
        for (const s of result.services) {
          hits.get(a)!.addService({
            name: s.name,
            title: s.text.title,
            description: s.text.description,
            tags: s.text.tags,
          });
        }
      } else if (result.status === "unavailable") {
        unsearched.push(a.id);
      }
      // invalid, not-bound, absent: nothing a buyer could pay, so nothing to match.
    });
    return unsearched.sort((x, y) => x - y);
  }

  private coverage(read: ScopeRead, pageHasMore: boolean): DiscoveryCoverage {
    const older = olderAgentsExist(read);
    const hasMore = pageHasMore || older;
    const unreadable = read.unreadable.length > 0;
    return {
      // Never complete: an allowlist is not the registry, a scan stops at its
      // window, and neither reads reputation. Each agent is read on its own, so
      // there is no shared ledger snapshot either.
      coverageComplete: false,
      paginationExhausted: !hasMore,
      snapshotConsistent: false,
      pagesScanned: 1,
      recordsScanned: read.agents.length,
      hasMore,
      limitations: [
        ...(this.scope.kind === "allowlist"
          ? [REGISTRY_ALLOWLIST_LIMITATION]
          : older
            ? [REGISTRY_NEWEST_LIMITATION]
            : []),
        REGISTRY_REPUTATION_LIMITATION,
        ...(unreadable ? [REGISTRY_UNREADABLE_LIMITATION] : []),
      ],
      ...(unreadable ? { unreadableAgentIds: read.unreadable } : {}),
      ...(read.total !== undefined ? { registryAgentCount: read.total } : {}),
    };
  }

  /** Read every agent in scope. A scan first counts the agents to find its window. */
  private async readScope(): Promise<ScopeRead> {
    if (this.scope.kind === "allowlist") return this.readAgents(this.scope.ids);
    const total = await this.cache.wrap("registry-agent-count", TTL_COUNT_MS, () =>
      this.rpc(() => readAgentCount(this.client)),
    );
    const start = Math.max(0, total - this.scope.limit);
    const ids = Array.from({ length: total - start }, (_, i) => total - 1 - i);
    return { ...(await this.readAgents(ids)), total, start };
  }

  /**
   * Read the given agents. One unreadable agent is reported, not fatal; but
   * when nothing could be read and the chain itself failed, throw — an outage
   * must not look like an empty registry. In a scan an unreadable registration
   * file is the registrant's problem, not an outage; an allowlist's agents were
   * chosen by the operator, so any failure counts.
   */
  private async readAgents(ids: readonly number[]): Promise<{ agents: AgentResponse[]; unreadable: number[] }> {
    const results = await mapWithConcurrency(ids, READ_CONCURRENCY, async (id) => {
      try {
        return { id, agent: await this.readAgent(id) };
      } catch (error) {
        return { id, error };
      }
    });
    const agents: AgentResponse[] = [];
    const unreadable: number[] = [];
    let outage: unknown;
    for (const result of results) {
      if (result.agent) {
        agents.push(result.agent);
        continue;
      }
      unreadable.push(result.id);
      const error = result.error;
      const detail = { agentId: result.id, error: error instanceof Error ? error.message : String(error) };
      if (this.scope.kind === "allowlist") {
        if (!(error instanceof NotFoundError)) outage ??= error;
        this.logger.warn("allowlisted agent could not be read", detail);
      } else {
        if (!(error instanceof NotFoundError) && !(error instanceof RegistrationUnreadableError)) outage ??= error;
        this.logger.debug("agent in the newest-agents scan could not be read", detail);
      }
    }
    if (agents.length === 0 && outage !== undefined) throw outage;
    return { agents, unreadable: unreadable.sort((a, b) => a - b) };
  }

  /**
   * One agent's row. A registration file that can't be read is cached like a
   * row, so each search does not fetch it again; a failed contract read is not.
   */
  private async readAgent(id: number): Promise<AgentResponse> {
    const read = await this.cache.wrap<AgentRead>(`registry-agent:${id}`, TTL_AGENT_MS, async () => {
      const identity = await this.rpc(() => readIdentity(this.client, id));
      if (!identity.uri) return { ok: true, row: toAgentRow(id, identity, {}) };
      try {
        return { ok: true, row: toAgentRow(id, identity, await readRegistration(id, identity.uri, this.fetcher)) };
      } catch (error) {
        if (error instanceof RegistrationUnreadableError) return { ok: false, error };
        throw error;
      }
    });
    if (!read.ok) throw read.error;
    return read.row;
  }
}

/** True when a scan stopped short of agent 0. */
function olderAgentsExist(read: ScopeRead): boolean {
  return read.start !== undefined && read.start > 0;
}

/**
 * How many agents the Identity contract has registered. Ids run from 0 to
 * count − 1. RegistryReadError when it can't be read or makes no sense.
 */
export async function readAgentCount(client: Pick<RegistryReadClient, "total_agents">): Promise<number> {
  let total: unknown;
  try {
    total = (await client.total_agents()).result;
  } catch (error) {
    throw new RegistryReadError("Identity contract agent count could not be read", { cause: error });
  }
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || total > MAX_AGENT_ID + 1) {
    throw new RegistryReadError("Identity contract returned a malformed agent count");
  }
  return total;
}

/** What the Identity contract itself says about one agent. */
export interface OnchainIdentity {
  /** The agent URI; "" when the agent has none. */
  uri: string;
  wallet: string | undefined;
  owner: string;
}

/**
 * `agent_uri`, `get_agent_wallet` and `find_owner` for one agent. NotFoundError
 * when it is not registered; RegistryReadError when the contract can't be read.
 */
export async function readIdentity(client: IdentityReadClient, id: number): Promise<OnchainIdentity> {
  let uriResult: { isOk(): boolean; unwrap(): string };
  let wallet: string | undefined;
  let owner: string | undefined;
  try {
    [uriResult, wallet, owner] = await Promise.all([
      client.agent_uri({ agent_id: id }).then((tx) => tx.result),
      client.get_agent_wallet({ agent_id: id }).then((tx) => tx.result),
      client.find_owner({ agent_id: id }).then((tx) => tx.result),
    ]);
  } catch (error) {
    throw new RegistryReadError(`Identity contract read for agent ${id} failed`, { cause: error });
  }
  if (!uriResult.isOk() || owner === undefined) {
    throw new NotFoundError(`agent ${id} (not registered in the Identity contract)`);
  }
  if (validWalletOrNull(owner) !== owner) {
    throw new RegistryReadError(`Identity contract returned a malformed owner for agent ${id}`);
  }
  return { uri: uriResult.unwrap(), wallet, owner };
}

/**
 * The services a registration file lists, the way registry mode decodes them:
 * `services`, or an older file's `endpoints`.
 */
export function registrationServiceEntries(registration: Record<string, unknown>): ServiceEntry[] {
  const services = registrationServices(registration.services);
  return services.length > 0 ? services : legacyEndpoints(registration.endpoints);
}

function assertNoScoreFilter(minScore: number | undefined): void {
  // The explorer's minScore is its indexed total_score. Ignoring the filter
  // would present unfiltered rows as if they had passed it.
  if (typeof minScore === "number" && minScore > 0) {
    throw new IndexerRequiredError(
      "Filtering by minExplorerScore (an explicit argument, or a stated threshold like 'score above 70')",
    );
  }
}

/** Local equivalents of the explorer's structured list filters. */
function matchesFilters(a: AgentResponse, f: Omit<GetAgentsParams, "search" | "page">): boolean {
  if (f.x402 !== undefined && (a.x402Enabled === true) !== f.x402) return false;
  if (f.mpp !== undefined && (a.mppEnabled === true) !== f.mpp) return false;
  if (f.hasServices !== undefined && ((a.services?.length ?? 0) > 0) !== f.hasServices) return false;
  if (f.trust !== undefined) {
    const wanted = f.trust.toLowerCase();
    if (!(a.supportedTrust ?? []).some((t) => t.trim().toLowerCase() === wanted)) return false;
  }
  return true;
}

/** The explorer row shape, from the contract reads and the decoded registration file. */
function toAgentRow(id: number, identity: OnchainIdentity, registration: UnknownRecord): AgentResponse {
  const { uri, wallet, owner } = identity;
  const services = registrationServiceEntries(registration);
  return {
    id,
    owner,
    wallet: wallet ?? null,
    agentUri: uri || null,
    name: optionalString(registration.name),
    description: optionalString(registration.description),
    image: optionalString(registration.image),
    services,
    hasServices: services.length > 0,
    supportedTrust: Array.isArray(registration.supportedTrust)
      ? registration.supportedTrust.filter((t): t is string => typeof t === "string")
      : [],
    // The SDK's registration builder writes `x402: true`; ERC-8004 drafts spell it `x402support`.
    x402Enabled: registration.x402 === true || registration.x402support === true,
    mppEnabled: registration.mpp === true,
    txHash: null,
    resolveStatus: uri ? "ready" : "no-uri",
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Registration `services` entries with a string name and endpoint; anything else is dropped. */
function registrationServices(value: unknown): ServiceEntry[] {
  if (!Array.isArray(value)) return [];
  const services: ServiceEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.endpoint !== "string") continue;
    if (!entry.name.trim() || !entry.endpoint.trim()) continue;
    services.push({
      name: entry.name,
      endpoint: entry.endpoint,
      ...(typeof entry.version === "string" ? { version: entry.version } : {}),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(typeof entry.inputExample === "string" ? { inputExample: entry.inputExample } : {}),
    });
  }
  return services;
}

/**
 * Older registration files list `endpoints: [{ type, url }]` instead of
 * `services`. Read them the way the SDK's edit path converts them
 * (endpointsToServices): `url` or `endpoint`, `type` or `name`, else "unknown".
 */
function legacyEndpoints(value: unknown): ServiceEntry[] {
  if (!Array.isArray(value)) return [];
  const services: ServiceEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const endpoint = typeof entry.url === "string" ? entry.url : typeof entry.endpoint === "string" ? entry.endpoint : "";
    if (!endpoint.trim()) continue;
    const name = typeof entry.type === "string" ? entry.type : typeof entry.name === "string" ? entry.name : "";
    services.push({
      name: name.trim() ? name : "unknown",
      endpoint,
      ...(typeof entry.version === "string" ? { version: entry.version } : {}),
    });
  }
  return services;
}

/**
 * The registration file an agent URI names: a `data:application/json` URI
 * (base64 or percent-encoded) or an `https:` URL on a public host. Other schemes
 * need an indexer or gateway this mode does not have, so they fail rather than
 * read as empty. Every failure is a RegistrationUnreadableError.
 */
export async function readRegistration(
  id: number,
  uri: string,
  fetcher: typeof fetch,
): Promise<UnknownRecord> {
  const fail = (reason: string, cause?: unknown): never => {
    throw new RegistrationUnreadableError(
      `Registration file for agent ${id} could not be read: ${reason}`,
      cause === undefined ? undefined : { cause },
    );
  };

  let text: string;
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    if (comma < 0) fail("malformed data: URI");
    const params = uri.slice(5, comma).split(";").map((p) => p.trim().toLowerCase());
    if (params[0] !== "application/json") fail("data: URI is not application/json");
    const payload = uri.slice(comma + 1);
    try {
      const bytes = params.includes("base64")
        ? Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(payload));
      if (bytes.byteLength > MAX_REGISTRATION_BYTES) fail("file is too large");
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof RegistryReadError) throw error;
      return fail("data: URI payload does not decode", error);
    }
  } else if (uri.startsWith("https://")) {
    // Any registrant chooses this URL: a local or private host is refused before
    // any request, so a registration cannot probe the network this server runs on.
    const problem = publicHttpsUrlProblem(uri, MAX_AGENT_URI_LENGTH);
    if (problem !== null) fail(`the registration URL is not usable: ${URL_PROBLEM_MESSAGES[problem]}`);
    let response: Response;
    try {
      response = await fetcher(uri, {
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REGISTRATION_TIMEOUT_MS),
      });
    } catch (error) {
      return fail("fetch failed", error);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      fail(`HTTP ${response.status}`);
    }
    text = await readCappedText(response, MAX_REGISTRATION_BYTES).catch((error: unknown) =>
      fail(error instanceof Error ? error.message : "body could not be read", error),
    );
  } else {
    return fail("only data: and https: agent URIs are readable in registry mode");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fail("file is not JSON", error);
  }
  if (!isRecord(parsed)) fail("file is not a JSON object");
  return parsed as UnknownRecord;
}
