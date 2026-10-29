/**
 * registry-source.ts — RegistryService: discovery straight from the Identity
 * contract, for networks without an indexer (testnet today).
 *
 * The operator names the agents (REGISTRY_AGENT_IDS). For each one the service
 * reads `agent_uri`, `get_agent_wallet` and `find_owner` — simulations on the
 * fetch-only transport in soroban.ts, no key and no transaction — then decodes
 * the registration file the URI points at (a `data:` URI or an `https:` URL)
 * into the same AgentResponse row the explorer returns. Every adapter
 * downstream (capabilities, self-declared slots, ranking, the AgentProfile
 * join) therefore runs unchanged.
 *
 * What it cannot know, it does not invent:
 *   - The contract cannot be enumerated, so lists and searches cover the
 *     allowlist only. Coverage says so, and names any agent it could not read.
 *   - There is no indexed reputation, so rows carry no scores. Results attach a
 *     `source` note that says scores and feedback counts are not measured.
 *   - Feedback, stats, health and owner lookups are not on this class at all
 *     (see source.ts), and a minScore filter is refused rather than ignored.
 *     (Tools drop a threshold implied by a word like "best" before it gets
 *     here, and say so: see queryMinScore in tools/shared.ts.)
 *
 * RegistryService fetches registration files only for allowlisted agents, never
 * for an id a caller supplies, with no redirects, a timeout and a size cap. The
 * contract and file reads are also exported (readIdentity, readRegistration):
 * provider-manifest.ts uses them in explorer mode to check a manifest's binding
 * to its registration [I1]–[I3] on chain rather than trust the indexer for it.
 */

import { NotFoundError, type AgentResponse, type ServiceEntry } from "@trionlabs/stellar8004";
import type { Config } from "../config.js";
import { systemClock, type Clock } from "./clock.js";
import { mapWithConcurrency } from "./concurrency.js";
import { IndexerRequiredError, RegistryReadError } from "./errors.js";
import {
  matchAgentsByQuery,
  TtlCache,
  type DiscoveryCoverage,
  type FindAgentsOptions,
  type FindAgentsResult,
  type GetAgentsParams,
} from "./explorer.js";
import { readCappedText } from "./http.js";
import { validWalletOrNull } from "./identifier.js";
import { log, type Logger } from "./logger.js";
import { createIdentityReadClient, type IdentityReadClient } from "./soroban.js";
import type {
  AgentListPage,
  ListAgentsParams,
  RegistrySource,
  RegistrySourceNote,
} from "./source.js";

/** Coverage limitation: the scan saw the operator's allowlist, not the registry. */
export const REGISTRY_ALLOWLIST_LIMITATION = "registry-allowlist-only";
/** Coverage limitation: no indexer, so reputation was not read. */
export const REGISTRY_REPUTATION_LIMITATION = "registry-reputation-not-indexed";
/** Coverage limitation: some allowlisted agents failed to read (see unreadableAgentIds). */
export const REGISTRY_UNREADABLE_LIMITATION = "registry-agents-unreadable";

const REGISTRY_NOTE =
  "Registry mode: agents come from the operator's allowlist (REGISTRY_AGENT_IDS), read directly from the " +
  "Identity contract. There is no indexer, so reputation is not measured: scores, feedback counts and the " +
  "unrated flag reflect missing data, not an agent without feedback.";

/** Same freshness as an explorer detail read. */
const TTL_AGENT_MS = 60_000;
const READ_CONCURRENCY = 6;
const REGISTRATION_TIMEOUT_MS = 10_000;
/** The contract stores URIs up to 8 KiB; a hosted file gets more room, but not unbounded. */
const MAX_REGISTRATION_BYTES = 64 * 1024;

export interface RegistryServiceOptions {
  clock?: Clock;
  logger?: Logger;
  /** Share per-agent reads across request-scoped instances. */
  cache?: TtlCache;
  /** Inject the Identity reader (tests). */
  client?: IdentityReadClient;
  /** Fetch for `https:` registration files (tests, or a runtime-specific fetch). */
  fetch?: typeof fetch;
  maxCacheEntries?: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class RegistryService implements RegistrySource {
  readonly kind = "registry" as const;
  private readonly agentIds: readonly number[];
  private readonly allowed: ReadonlySet<number>;
  private readonly client: IdentityReadClient;
  private readonly fetcher: typeof fetch;
  private readonly cache: TtlCache;
  private readonly logger: Logger;

  constructor(cfg: Config, opts: RegistryServiceOptions = {}) {
    if (!cfg.registryAgentIds) {
      throw new Error("RegistryService needs config.registryAgentIds (REGISTRY_AGENT_IDS)");
    }
    this.agentIds = [...cfg.registryAgentIds].sort((a, b) => a - b);
    this.allowed = new Set(this.agentIds);
    this.client =
      opts.client ??
      createIdentityReadClient(cfg, cfg.simSource ? { simSource: cfg.simSource } : {});
    this.fetcher = opts.fetch ?? ((input, init) => fetch(input, init));
    this.cache =
      opts.cache ??
      new TtlCache({ maxEntries: opts.maxCacheEntries ?? 200, clock: opts.clock ?? systemClock });
    this.logger = (opts.logger ?? log).child({ component: "registry" });
  }

  describe(): RegistrySourceNote {
    return {
      kind: "registry",
      allowlistSize: this.agentIds.length,
      reputationIndexed: false,
      note: REGISTRY_NOTE,
    };
  }

  /** One allowlisted agent. Ids outside the allowlist are not read at all. */
  async getAgent(id: number): Promise<{ data: AgentResponse }> {
    if (!this.allowed.has(id)) {
      throw new NotFoundError(`agent ${id} (registry mode reads only REGISTRY_AGENT_IDS)`);
    }
    return { data: await this.readAgent(id) };
  }

  /** The allowlist in id order (registration order), filtered, one page at a time. */
  async listAgents(params: ListAgentsParams): Promise<AgentListPage> {
    assertNoScoreFilter(params.minScore);
    const { agents, unreadable } = await this.readAllowlist();
    const matching = agents.filter((a) => matchesFilters(a, params));
    const offset = (params.page - 1) * params.limit;
    const page = matching.slice(offset, offset + params.limit);
    const hasMore = offset + params.limit < matching.length;
    return {
      agents: page,
      pagination: { page: params.page, limit: params.limit, total: matching.length, hasMore },
      coverage: this.coverage(agents.length, unreadable, hasMore),
    };
  }

  /** Every allowlisted agent matching the filters and the query; `pages` does not apply. */
  async findAgentsWithCoverage(
    query: string,
    opts: FindAgentsOptions = {},
  ): Promise<FindAgentsResult> {
    const filters = opts.filters ?? {};
    assertNoScoreFilter(filters.minScore);
    const { agents, unreadable } = await this.readAllowlist();
    const coverage = this.coverage(agents.length, unreadable, false);
    const matched = matchAgentsByQuery(
      agents.filter((a) => matchesFilters(a, filters)),
      query ?? "",
      opts.match ?? "all",
    );
    if (matched === null) {
      return {
        agents: [],
        coverage: { ...coverage, limitations: [...coverage.limitations!, "query-no-search-tokens"] },
      };
    }
    return { agents: matched, coverage };
  }

  private coverage(read: number, unreadable: number[], hasMore: boolean): DiscoveryCoverage {
    return {
      // The allowlist was read in full, but the allowlist is not the registry.
      coverageComplete: false,
      paginationExhausted: !hasMore,
      // Each agent is read on its own; no shared ledger snapshot.
      snapshotConsistent: false,
      pagesScanned: 1,
      recordsScanned: read,
      hasMore,
      limitations: [
        REGISTRY_ALLOWLIST_LIMITATION,
        REGISTRY_REPUTATION_LIMITATION,
        ...(unreadable.length > 0 ? [REGISTRY_UNREADABLE_LIMITATION] : []),
      ],
      ...(unreadable.length > 0 ? { unreadableAgentIds: unreadable } : {}),
    };
  }

  /**
   * Read every allowlisted agent. One unreadable agent is reported, not fatal;
   * but when nothing could be read and something failed for a reason other than
   * "not registered", throw — an outage must not look like an empty registry.
   */
  private async readAllowlist(): Promise<{ agents: AgentResponse[]; unreadable: number[] }> {
    const results = await mapWithConcurrency(this.agentIds, READ_CONCURRENCY, async (id) => {
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
      if (!(result.error instanceof NotFoundError)) outage ??= result.error;
      this.logger.warn("allowlisted agent could not be read", {
        agentId: result.id,
        error: result.error instanceof Error ? result.error.message : String(result.error),
      });
    }
    if (agents.length === 0 && outage !== undefined) throw outage;
    return { agents, unreadable };
  }

  private readAgent(id: number): Promise<AgentResponse> {
    return this.cache.wrap(`registry-agent:${id}`, TTL_AGENT_MS, async () => {
      const identity = await readIdentity(this.client, id);
      const registration = identity.uri ? await readRegistration(id, identity.uri, this.fetcher) : {};
      return toAgentRow(id, identity, registration);
    });
  }
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
 * (base64 or percent-encoded) or an `https:` URL. Other schemes need an indexer
 * or gateway this mode does not have, so they fail rather than read as empty.
 */
export async function readRegistration(
  id: number,
  uri: string,
  fetcher: typeof fetch,
): Promise<UnknownRecord> {
  const fail = (reason: string, cause?: unknown): never => {
    throw new RegistryReadError(
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
    if (!response.ok) fail(`HTTP ${response.status}`);
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
