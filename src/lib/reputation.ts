/**
 * reputation.ts — ReputationVerifier: bounded on-chain comparison of an
 * agent's indexed reputation and a field-scoped declared-vs-chain diff.
 *
 * This is READ-ONLY. It uses the generated contract spec on a fetch-only SDK
 * build (see `soroban.ts` for why), which
 * auto-simulate: the read result lives on the returned
 * `AssembledTransaction.result`. There is NO signing, NO keypair, NO write —
 * the client is constructed with a source public key used only as the
 * simulation origin. (modules/01 §2.4.2 + §3.4.)
 *
 * Current flow per agent:
 *   1. get_clients_paginated(agent_id, 0, 6) → bounded reachability observation.
 *   2. stop with `client-set-exhaustion-unprovable`.
 *
 * The canonical contract skips expired ClientAtIndex entries and exposes no
 * authoritative count/cursor. Therefore no finite sequence of offset probes
 * can prove that a later retained client does not exist. Calling get_summary
 * over such a set could manufacture a false parity/mismatch, so the current
 * release never calls it. A future authoritative cursor or maintained aggregate
 * can re-enable the field comparison without changing the public result shape.
 *
 * DEGRADE-CLOSED: an unprovable client-set boundary or any RPC failure maps to
 * status "unavailable". We never block a tool and never emit a false
 * "partial"/"mismatch" from an incomplete client set. Verification is bounded
 * (top-K agents, decided by the caller; one-minute cache).
 */

import { createReputationReadClient, type ReputationReadClient } from "./soroban.js";
import type { Config } from "../config.js";
import type {
  DeclaredReputation,
  OnchainReputation,
  VerificationResult,
} from "../types.js";
import { systemClock, type Clock } from "./clock.js";
import { classifyError } from "./errors.js";
import { log, type Logger } from "./logger.js";
import { TtlCache } from "./explorer.js";

/**
 * Read-only simulation source.
 *
 * The SDK's contract client resolves the simulation origin as:
 *     options.publicKey ? server.getAccount(options.publicKey)
 *                       : new Account(NULL_ACCOUNT, "0")
 * (@stellar/stellar-sdk contract/utils.ts). Passing ANY publicKey forces a live
 * getAccount() lookup, which public Soroban RPCs reject with "account not found"
 * for any not-fully-resolvable account — the all-zero account, and in practice
 * even sponsored owner accounts. That silently disabled on-chain verification on
 * the default mainnet config (it degraded every read to "unavailable").
 *
 * So we OMIT publicKey: the SDK then simulates from its built-in fabricated
 * NULL_ACCOUNT (sequence 0) WITHOUT calling getAccount, and read simulation runs
 * with no funded account. (Verified live: get_clients_paginated(agent) returns
 * the real client set against https://mainnet.sorobanrpc.com.) A real funded
 * account can still be supplied via RANK_SIM_SOURCE to override, but it is not
 * required. Reads never sign, so the fabricated account is never a problem.
 */

/** Bounded reachability read; it is deliberately not an exhaustion proof. */
const CLIENT_OBSERVATION_LIMIT = 6;

/** Cache TTLs (ms): both successful and degraded reads refresh within one minute. */
const TTL_OK = 60_000;
const TTL_NEGATIVE = 60_000;

const UNVERSIONED_SNAPSHOT_LIMITATION =
  "Explorer and Soroban reads do not share a common revision or ledger-bound snapshot; " +
  "matching or differing values are observational and are not proof of synchronized parity or manipulation.";
const CLIENT_INDEX_LIMITATION =
  "The contract exposes no client-count/cursor proof and expired ClientAtIndex entries can create holes; " +
  "the bounded read cannot prove exhaustive client history, so get_summary is not called and no reputation field is verified.";
const UNIQUE_CLIENT_LIMITATION =
  "Active unique-client breadth is not derivable from the contract's append-only client list.";

type SnapshotAwareVerificationResult = VerificationResult & {
  snapshotComparable: false;
  limitations: string[];
};

function snapshotContext(): Pick<
  SnapshotAwareVerificationResult,
  "snapshotComparable" | "limitations"
> {
  return {
    snapshotComparable: false,
    limitations: [
      UNVERSIONED_SNAPSHOT_LIMITATION,
      CLIENT_INDEX_LIMITATION,
      UNIQUE_CLIENT_LIMITATION,
    ],
  };
}

/** Why an on-chain read produced no trustworthy value — see {@link ReputationVerifier.probe}. */
export type VerifyFailure =
  | "disabled" // verification switched off (VERIFY_ONCHAIN=false)
  | "client-set-exhaustion-unprovable" // no authoritative count/cursor exists
  | "rpc-error"; // transport/simulation failure

/** Uncached read outcome that keeps failures distinguishable from empty data. */
export type VerifyProbe =
  | { ok: true; value: OnchainReputation }
  | { ok: false; reason: VerifyFailure; detail?: string };

/**
 * Health-only contract probe. `observedClients` is the compacted number of
 * addresses returned from one bounded index window; it is never a client count
 * or an exhaustion proof.
 */
export type ReputationReachabilityProbe =
  | { ok: true; observedClients: number; start: 0; limit: number }
  | { ok: false; reason: "disabled" | "rpc-error"; detail?: string };

/** Cached together so a reused chain read never masquerades as freshly checked. */
interface VerificationSnapshot {
  value: OnchainReputation | null;
  checkedAt: string;
  failure?: VerifyFailure;
}

export interface ReputationVerifierOptions {
  clock?: Clock;
  logger?: Logger;
  /** Share actor-neutral Soroban read results across request-scoped verifiers. */
  cache?: TtlCache;
  /** Inject a pre-built binding (tests). */
  client?: ReputationReadClient;
  /**
   * Read-simulation source G-address. Falls back to config.simSource (loaded
   * from RANK_SIM_SOURCE); if neither is set, publicKey is omitted so the SDK simulates from its fabricated
   * NULL_ACCOUNT with no getAccount lookup (the default — no funded account
   * needed). Only provide this to force a specific funded source.
   */
  simSource?: string;
  maxCacheEntries?: number;
}

export class ReputationVerifier {
  private readonly client: ReputationReadClient | null;
  private readonly cache: TtlCache;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly enabled: boolean;

  constructor(cfg: Config, opts: ReputationVerifierOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.logger = (opts.logger ?? log).child({ component: "reputation" });
    this.cache =
      opts.cache ??
      new TtlCache({ maxEntries: opts.maxCacheEntries ?? 200, clock: this.clock });
    this.enabled = cfg.verifyOnchain;
    if (!this.enabled) {
      this.client = null;
    } else if (opts.client) {
      this.client = opts.client;
    } else {
      // Only pass a publicKey when the operator explicitly provides a funded
      // source; otherwise omit it so the SDK uses its fabricated NULL_ACCOUNT and
      // skips the getAccount() lookup that would otherwise fail on public RPCs.
      const simSource = opts.simSource ?? cfg.simSource;
      this.client = createReputationReadClient(cfg, { ...(simSource ? { simSource } : {}) });
    }
  }

  /** Whether on-chain verification is active for this instance. */
  get isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }

  /**
   * Attempt a bounded reputation read. Returns null until the contract exposes
   * an authoritative client-set cursor/count (and on any transport failure), so
   * callers remain declared-only rather than comparing an incomplete set.
   * Bounded + cached (60 s for either a value or a degraded result).
   */
  async verify(agentId: number): Promise<OnchainReputation | null> {
    if (!this.isEnabled) return null;
    return (await this.verificationSnapshot(agentId)).value;
  }

  /** Return the value and the time the underlying read actually ran. */
  private verificationSnapshot(
    agentId: number,
    excludeClient?: string,
  ): Promise<VerificationSnapshot> {
    const exclusionKey = excludeClient?.trim() || "none";
    return this.cache.wrap<VerificationSnapshot>(
      `rep:${agentId}:exclude:${exclusionKey}`,
      (snapshot) => (snapshot.value == null ? TTL_NEGATIVE : TTL_OK),
      async () => {
        const probe = await this.probe(agentId, { excludeClient });
        return {
          value: probe.ok ? probe.value : null,
          checkedAt: this.clock.nowIso(),
          ...(probe.ok ? {} : { failure: probe.reason }),
        };
      },
    );
  }

  /**
   * Uncached health probe for the exact contract read path. A successful result
   * proves reachability only; it never means reputation is comparable.
   */
  async probeReachability(agentId: number): Promise<ReputationReachabilityProbe> {
    if (!this.isEnabled) return { ok: false, reason: "disabled" };
    const client = this.client!;
    try {
      const tx = await client.get_clients_paginated({
        agent_id: agentId,
        start: 0,
        limit: CLIENT_OBSERVATION_LIMIT,
      });
      if (!Array.isArray(tx.result)) {
        throw new Error("get_clients_paginated returned a malformed result");
      }
      return {
        ok: true,
        observedClients: tx.result.length,
        start: 0,
        limit: CLIENT_OBSERVATION_LIMIT,
      };
    } catch (err) {
      const body = classifyError(err);
      this.logger.debug("on-chain reputation reachability probe failed", {
        agentId,
        errorCode: body.code,
      });
      return { ok: false, reason: "rpc-error", detail: body.error };
    }
  }

  /**
   * Uncached comparison probe. Reachability and comparability are deliberately
   * separate: a successful bounded client-list simulation still cannot prove
   * that the compacted list is exhaustive, including when it is empty.
   */
  async probe(
    agentId: number,
    opts: { excludeClient?: string } = {},
  ): Promise<VerifyProbe> {
    const reachability = await this.probeReachability(agentId);
    if (reachability.ok) {
      this.logger.debug("client-set exhaustion cannot be proven; summary skipped", {
        agentId,
        observedClients: reachability.observedClients,
        ownerExclusionRequested: Boolean(opts.excludeClient?.trim()),
      });
      return { ok: false, reason: "client-set-exhaustion-unprovable" };
    }
    return reachability;
  }

  // --- fail-closed evidence result ------------------------------------------

  /**
   * Bounded verification for one agent against the explorer's DECLARED reputation.
   * - `opts.skip` (or verification disabled) → status "skipped" (e.g. out of top-K).
   * - current bounded chain read → "unavailable" with
   *   `client-set-exhaustion-unprovable` until the contract exposes an
   *   authoritative cursor/count/aggregate.
   */
  async verifyAgainst(
    agentId: number,
    declared: DeclaredReputation,
    opts: { skip?: boolean; excludeClient?: string } = {},
  ): Promise<SnapshotAwareVerificationResult> {
    if (!this.isEnabled || opts.skip) {
      return {
        ...snapshotContext(),
        status: "skipped",
        declared,
        reason: !this.isEnabled ? "disabled" : "not-requested",
        verifiedFields: [],
        unverifiedFields: ["average", "feedbackCount", "uniqueClients"],
        checkedAt: this.clock.nowIso(),
      };
    }

    const snapshot = await this.verificationSnapshot(agentId, opts.excludeClient);
    const { value: onchain, checkedAt } = snapshot;
    if (onchain == null) {
      return {
        ...snapshotContext(),
        status: "unavailable",
        declared,
        reason: snapshot.failure ?? "rpc-error",
        verifiedFields: [],
        unverifiedFields: ["average", "feedbackCount", "uniqueClients"],
        checkedAt,
      };
    }

    // Defensive future-proofing: current probe never returns a value. If that
    // invariant changes, fail closed until an authoritative comparison path is
    // implemented and reviewed rather than silently reviving the legacy diff.
    void onchain;
    return {
      ...snapshotContext(),
      status: "unavailable",
      declared,
      reason: "client-set-exhaustion-unprovable",
      verifiedFields: [],
      unverifiedFields: ["average", "feedbackCount", "uniqueClients"],
      checkedAt,
    };
  }

  /** Build a "skipped" result without any RPC (caller decided out of top-K). */
  skipped(declared: DeclaredReputation): SnapshotAwareVerificationResult {
    return {
      ...snapshotContext(),
      status: "skipped",
      declared,
      reason: "not-requested",
      verifiedFields: [],
      unverifiedFields: ["average", "feedbackCount", "uniqueClients"],
      checkedAt: this.clock.nowIso(),
    };
  }

  /** Test/utility: drop the verification cache. */
  clearCache(): void {
    this.cache.clear();
  }
}
