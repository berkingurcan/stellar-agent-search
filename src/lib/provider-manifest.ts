/**
 * provider-manifest.ts — ProviderManifestService: an agent's Provider Standard v1
 * manifest, checked against its on-chain registration, with conformance badges
 * from the Validation Registry.
 *
 * For one agent:
 *   1. Locate. The registration's services name the manifest [I1]. In registry
 *      mode the source row already is the on-chain registration. In explorer
 *      mode the registration is read again on chain (agent_uri, then the file),
 *      so which provider a user would pay never rests on the indexer. When that
 *      file can't be read (an ipfs: URI, an outage), the indexed services only
 *      locate the manifest and [I1] is reported unverified.
 *   2. Fetch, the way a client must [M1][M3]: a public HTTPS URL, no redirect, at
 *      most 256 KiB, `application/json`, I-JSON; then read (provider-standard.ts).
 *      A manifest for another network than this server's is refused: one flow
 *      never mixes testnet and mainnet.
 *   3. Bind [I1]–[I3]: the registration names this URL, the manifest names this
 *      agent, and its payTo is the agent's on-chain wallet. Together they
 *      authenticate the manifest without a signature (§7).
 *   4. Attest: badges from trusted validators' records (validation.ts).
 *
 * Read-only and keyless: contract simulations and two GETs at most. Nothing here
 * pays, signs or calls a job endpoint.
 */

import type { AgentResponse, ServiceEntry } from "@trionlabs/stellar8004";
import type { Config } from "../config.js";
import { systemClock, type Clock } from "./clock.js";
import { TtlCache } from "./explorer.js";
import {
  BodyTooLargeError,
  publicHttpsUrlProblem,
  readCappedBytes,
  URL_PROBLEM_MESSAGES,
  type UrlProblem,
} from "./http.js";
import { validWalletOrNull } from "./identifier.js";
import { log, type Logger } from "./logger.js";
import {
  caip2Network,
  findManifestDeclaration,
  MANIFEST_MAX_BYTES,
  MAX_MANIFEST_URL_LENGTH,
  parseManifestText,
  type ManifestProblem,
  type ProviderManifestView,
} from "./provider-standard.js";
import {
  readIdentity,
  readRegistration,
  registrationServiceEntries,
  type OnchainIdentity,
} from "./registry-source.js";
import { createIdentityReadClient, type IdentityReadClient, type ValidationReadClient } from "./soroban.js";
import {
  ValidationEvidenceReader,
  type ValidationEvidence,
  type ValidationReadBudget,
} from "./validation.js";
import type { Network } from "../types.js";

const MANIFEST_TIMEOUT_MS = 10_000;
/** Within the standard's advice that manifests be cached for at most 300 s [M4]. */
const MANIFEST_TTL_MS = 60_000;

/**
 * - ok: the manifest was read, and every field this server shows is valid.
 * - absent: the registration names no Provider Standard manifest.
 * - invalid: the declaration or the manifest breaks a rule (see `problems`).
 * - unavailable: the provider could not be reached; try again later.
 */
export type ManifestStatus = "ok" | "absent" | "invalid" | "unavailable";

export type IdentityCheckStatus = "pass" | "fail" | "unverified";

export interface IdentityCheck {
  rule: "I1" | "I2" | "I3";
  status: IdentityCheckStatus;
  /** Server-authored; never quotes provider text. */
  message: string;
}

export interface IdentityBinding {
  /** bound: [I1]–[I3] all pass. not-bound: one fails. unverified: none fails, one could not be checked. */
  status: "bound" | "not-bound" | "unverified";
  /** Where the registration that names the manifest was read: the Identity contract, or only the indexer. */
  registration: "onchain" | "indexed";
  checks: IdentityCheck[];
}

export interface ProviderManifestResult {
  agentId: number;
  network: Network;
  status: ManifestStatus;
  /** The manifest URL the registration names, raw; null when absent or unusable. Sanitize before output. */
  manifestUrl: string | null;
  /** Present only when status is ok. */
  manifest: ProviderManifestView | null;
  /** Present only when status is ok. */
  identity: IdentityBinding | null;
  /** Present only when status is ok. */
  validation: ValidationEvidence | null;
  problems: ManifestProblem[];
}

export interface ProviderManifestServiceOptions {
  /** Identity contract reader for explorer mode (tests inject a fake). */
  identityClient?: IdentityReadClient;
  /** Validation Registry reader (tests inject a fake). */
  validationClient?: ValidationReadClient;
  /** Fetch for registration files and manifests (tests, or a runtime-specific fetch). */
  fetch?: typeof fetch;
  cache?: TtlCache;
  clock?: Clock;
  logger?: Logger;
}

/** Where the manifest declaration was read, and who the chain says the agent is. */
interface Registration {
  services: readonly ServiceEntry[];
  provenance: "onchain" | "indexed";
  /** Why the on-chain registration could not be read (explorer mode). */
  unreadable?: string;
  owner: string;
  /** The on-chain wallet; null when none is set; undefined when the chain could not be read. */
  wallet: string | null | undefined;
}

type FetchOutcome =
  | { kind: "text"; text: string }
  | { kind: "invalid"; problem: ManifestProblem }
  | { kind: "unavailable"; problem: ManifestProblem };

/** Thrown from the cache loader so an unreachable provider is never cached. */
class ProviderUnreachable extends Error {
  constructor(readonly outcome: FetchOutcome) {
    super(outcome.kind === "text" ? "unreachable" : outcome.problem.message);
  }
}

export class ProviderManifestService {
  private readonly cfg: Config;
  private readonly fetcher: typeof fetch;
  private readonly cache: TtlCache;
  private readonly logger: Logger;
  private readonly injectedIdentity: IdentityReadClient | undefined;
  private identity: IdentityReadClient | undefined;
  private readonly validation: ValidationEvidenceReader;

  constructor(cfg: Config, opts: ProviderManifestServiceOptions = {}) {
    this.cfg = cfg;
    this.fetcher = opts.fetch ?? ((input, init) => fetch(input, init));
    const clock = opts.clock ?? systemClock;
    this.cache = opts.cache ?? new TtlCache({ maxEntries: 200, clock });
    this.logger = (opts.logger ?? log).child({ component: "provider-manifest" });
    this.injectedIdentity = opts.identityClient;
    this.validation = new ValidationEvidenceReader(cfg, {
      ...(opts.validationClient ? { client: opts.validationClient } : {}),
      cache: this.cache,
      clock,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
  }

  /**
   * The manifest of the agent `row` describes. `onchain` says the row was read
   * from the Identity contract (registry mode); otherwise it came from the
   * indexer and the registration is read again on chain.
   */
  async read(
    row: AgentResponse,
    opts: { onchain: boolean; budget?: ValidationReadBudget },
  ): Promise<ProviderManifestResult> {
    const result: ProviderManifestResult = {
      agentId: row.id,
      network: this.cfg.network,
      status: "absent",
      manifestUrl: null,
      manifest: null,
      identity: null,
      validation: null,
      problems: [],
    };

    const registration = opts.onchain ? fromRow(row, "onchain") : await this.onchainRegistration(row);
    const declaration = findManifestDeclaration(registration.services);
    if (declaration.kind === "absent") return result;
    if (declaration.kind === "invalid") return { ...result, status: "invalid", problems: [declaration.problem] };

    const url = declaration.url;
    const urlProblem = publicHttpsUrlProblem(url, MAX_MANIFEST_URL_LENGTH);
    if (urlProblem !== null) {
      return { ...result, status: "invalid", problems: [urlRule(urlProblem, "the manifest URL")] };
    }
    result.manifestUrl = url;

    const fetched = await this.fetchManifest(url);
    if (fetched.kind !== "text") return { ...result, status: fetched.kind, problems: [fetched.problem] };

    const parsed = parseManifestText(fetched.text, url);
    if (!parsed.ok) return { ...result, status: "invalid", problems: parsed.problems };
    const manifest = parsed.manifest;

    const expected = caip2Network(this.cfg.network);
    if (manifest.payment.network !== expected) {
      return {
        ...result,
        status: "invalid",
        problems: [
          {
            message: `the manifest takes payment on ${manifest.payment.network}, but this agent is registered on ${expected}`,
          },
        ],
      };
    }

    return {
      ...result,
      status: "ok",
      manifest,
      identity: bind(row.id, manifest, registration),
      validation: await this.validation.read(
        row.id,
        { owner: registration.owner, wallet: registration.wallet ?? null },
        opts.budget,
      ),
    };
  }

  private identityClient(): IdentityReadClient {
    this.identity ??=
      this.injectedIdentity ??
      createIdentityReadClient(this.cfg, this.cfg.simSource ? { simSource: this.cfg.simSource } : {});
    return this.identity;
  }

  /**
   * Explorer mode: the registration as the Identity contract and the file its
   * URI names state it. Falls back to the indexed row, labeled, when either
   * can't be read.
   */
  private async onchainRegistration(row: AgentResponse): Promise<Registration> {
    let identity: OnchainIdentity;
    try {
      identity = await readIdentity(this.identityClient(), row.id);
    } catch (error) {
      this.logger.warn("identity contract read failed", { agentId: row.id, error: errorText(error) });
      return { ...fromRow(row, "indexed"), wallet: undefined, unreadable: "the Identity contract could not be read" };
    }
    const fallback = (reason: string): Registration => ({
      ...fromRow(row, "indexed"),
      owner: identity.owner,
      wallet: validWalletOrNull(identity.wallet),
      unreadable: reason,
    });

    const uri = identity.uri;
    if (!uri.startsWith("data:") && !uri.startsWith("https://")) {
      return fallback(uri === "" ? "the agent has no registration URI" : "the registration URI is neither data: nor https:");
    }
    if (uri.startsWith("https://")) {
      const problem = publicHttpsUrlProblem(uri, 8 * 1024);
      if (problem !== null) return fallback(`the registration URI is unusable: ${URL_PROBLEM_MESSAGES[problem]}`);
    }
    try {
      const file = await readRegistration(row.id, uri, this.fetcher);
      return {
        services: registrationServiceEntries(file),
        provenance: "onchain",
        owner: identity.owner,
        wallet: validWalletOrNull(identity.wallet),
      };
    } catch (error) {
      this.logger.warn("registration file read failed", { agentId: row.id, error: errorText(error) });
      return fallback("the registration file could not be read");
    }
  }

  /** The manifest text, or why there is none. Only a reachable provider's answer is cached. */
  private async fetchManifest(url: string): Promise<FetchOutcome> {
    try {
      return await this.cache.wrap(`manifest:${url}`, MANIFEST_TTL_MS, async () => {
        const outcome = await this.fetchManifestOnce(url);
        if (outcome.kind === "unavailable") throw new ProviderUnreachable(outcome);
        return outcome;
      });
    } catch (error) {
      if (error instanceof ProviderUnreachable) return error.outcome;
      throw error;
    }
  }

  private async fetchManifestOnce(url: string): Promise<FetchOutcome> {
    const invalid = (rule: string, message: string): FetchOutcome => ({ kind: "invalid", problem: { rule, message } });
    const unavailable = (message: string): FetchOutcome => ({ kind: "unavailable", problem: { message } });

    let response: Response;
    try {
      response = await this.fetcher(url, {
        // [M3]: never follow. "manual" hands back the 3xx so it can be named.
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn("manifest fetch failed", { error: errorText(error) });
      return unavailable("the manifest could not be fetched");
    }
    const status = response.status;
    if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
      await response.body?.cancel();
      return invalid("M3", "the manifest URL redirects, and clients must not follow redirects");
    }
    if (status === 429 || status >= 500) {
      await response.body?.cancel();
      return unavailable(`the provider answered HTTP ${status}`);
    }
    if (status !== 200) {
      await response.body?.cancel();
      return invalid("M1", `the manifest URL answered HTTP ${status}, not 200`);
    }
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      await response.body?.cancel();
      return invalid("M1", "the manifest is not served as application/json");
    }

    let bytes: Uint8Array;
    try {
      bytes = await readCappedBytes(response, MANIFEST_MAX_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return invalid("M3", "the manifest is larger than 256 KiB");
      this.logger.warn("manifest body read failed", { error: errorText(error) });
      return unavailable("the manifest could not be read");
    }
    try {
      return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      return invalid("M3", "the manifest is not UTF-8");
    }
  }
}

/** The registration as an already decoded row states it. */
function fromRow(row: AgentResponse, provenance: Registration["provenance"]): Registration {
  return {
    services: row.services ?? [],
    provenance,
    owner: row.owner,
    wallet: provenance === "onchain" ? validWalletOrNull(row.wallet) : undefined,
  };
}

/** [I1]–[I3] for a manifest that was read. */
function bind(agentId: number, manifest: ProviderManifestView, registration: Registration): IdentityBinding {
  const checks: IdentityCheck[] = [];

  checks.push(
    registration.provenance === "onchain"
      ? { rule: "I1", status: "pass", message: 'the on-chain registration lists this manifest with version "1"' }
      : {
          rule: "I1",
          status: "unverified",
          message: `${registration.unreadable ?? "the registration was not read on chain"}; the indexer located the manifest`,
        },
  );

  checks.push(
    manifest.agentId === agentId
      ? { rule: "I2", status: "pass", message: "the manifest names this agent" }
      : {
          rule: "I2",
          status: "fail",
          message:
            manifest.agentId === null
              ? "the manifest has no provider.agentId"
              : `the manifest names agent ${manifest.agentId}, not ${agentId}`,
        },
  );

  const wallet = registration.wallet;
  checks.push(
    wallet === undefined
      ? { rule: "I3", status: "unverified", message: "the agent's wallet could not be read on chain" }
      : wallet === manifest.payment.payTo
        ? { rule: "I3", status: "pass", message: "payTo is the agent's on-chain wallet" }
        : {
            rule: "I3",
            status: "fail",
            message:
              wallet === null ? "the agent has no wallet set on chain" : "payTo is not the agent's on-chain wallet",
          },
  );

  const status = checks.some((c) => c.status === "fail")
    ? "not-bound"
    : checks.every((c) => c.status === "pass")
      ? "bound"
      : "unverified";
  return { status, registration: registration.provenance, checks };
}

function urlRule(problem: UrlProblem, what: string): ManifestProblem {
  const message = `${what}: ${URL_PROBLEM_MESSAGES[problem]}`;
  if (problem === "not-https") return { rule: "M1", message };
  if (problem === "too-long" || problem === "user-info" || problem === "unparseable") return { rule: "M6", message };
  // A public host is this server's own fetch policy, not a rule of the standard.
  return { message };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
