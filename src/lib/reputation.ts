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
 * Flow per agent:
 *   1. get_clients_paginated(agent_id, start, limit) → inspect a bounded client
 *      window and refuse an observed overflow beyond the five-client summary cap.
 *   2. get_summary(agent_id, client_addresses, "", "") → WAD-normalized average
 *      across those clients: average = summary_value / 10^summary_value_decimals.
 *   3. compare average + active feedbackCount with the explorer. Active
 *      uniqueClients cannot be derived from the append-only contract client
 *      list and remains explicitly unverified.
 *
 * DEGRADE-CLOSED: any RPC failure, simulation rejection, contract error, a
 * truncated (capped) client set, or an out-of-range unit maps to null →
 * status "unavailable". We never block a tool and never emit a false
 * "mismatch" when the on-chain value cannot be trusted. Verification is
 * bounded (top-K agents, decided by the caller; ~10-min cache).
 */

import { type SummaryResult } from "@trionlabs/stellar8004";
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

/**
 * Canonical contract `get_summary` silently processes at most five supplied
 * clients (`MAX_SUMMARY_CLIENTS = 5`). Until the contract exposes a maintained
 * full aggregate, only a complete comparable set of <=5 reviewers can be
 * truthfully re-derived.
 */
const SUMMARY_CLIENT_CAP = 5;
// Read one extra address so exactly six can be distinguished in one page. The
// indexer excludes owner self-feedback while the contract does not, so six raw
// clients can still mean five comparable clients after removing the owner.
const CLIENT_SCAN_PAGE = SUMMARY_CLIENT_CAP + 1;

/** Cache TTLs (ms): both successful and degraded reads refresh within one minute. */
const TTL_OK = 60_000;
const TTL_NEGATIVE = 60_000;

/** Declared-vs-on-chain tolerances (modules/01 §3, DEFAULTS.VERIFY_TOLERANCE). */
export interface VerifyTolerance {
  /** Max |declared − on-chain| average delta, AFTER precision-normalization. */
  average: number;
  /** Max explorer-vs-contract feedback count delta. */
  feedbackCount: number;
}
// Tolerances stay TIGHT (0.5): the integer-vs-fractional average representation
// gap is neutralized precisely at compare time (see verifyAgainst) rather than by
// globally loosening the mismatch threshold — a loose absolute constant both masks
// sub-point inflation and scales wrong when RANK_SCORE_MAX is not 100.
export const DEFAULT_TOLERANCE: VerifyTolerance = {
  average: 0.5,
  // Counts are exact integers. A one-row difference can be ordinary index lag,
  // but it is still a difference; the unversioned-snapshot limitation below
  // explains why that difference is not evidence of manipulation.
  feedbackCount: 0,
};

const UNVERSIONED_SNAPSHOT_LIMITATION =
  "Explorer and Soroban reads do not share a common revision or ledger-bound snapshot; " +
  "matching or differing values are observational and are not proof of synchronized parity or manipulation.";
const CLIENT_INDEX_LIMITATION =
  "The contract exposes no client-count/cursor proof and expired ClientAtIndex entries can create holes; " +
  "the bounded scan cannot prove exhaustive client history, so only the returned average/count observation is compared.";
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
  | "truncated" // client set exceeded the hard cap; cannot fully account for it
  | "contract-error" // get_summary returned Err
  | "out-of-range" // summary unit outside the representable scale
  | "rpc-error"; // transport/simulation failure

/** Uncached read outcome that keeps failures distinguishable from empty data. */
export type VerifyProbe =
  | { ok: true; value: OnchainReputation }
  | { ok: false; reason: VerifyFailure; detail?: string };

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
  tolerance?: Partial<VerifyTolerance>;
  maxCacheEntries?: number;
}

export class ReputationVerifier {
  private readonly client: ReputationReadClient | null;
  private readonly cache: TtlCache;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly tolerance: VerifyTolerance;

  constructor(cfg: Config, opts: ReputationVerifierOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.logger = (opts.logger ?? log).child({ component: "reputation" });
    this.cache =
      opts.cache ??
      new TtlCache({ maxEntries: opts.maxCacheEntries ?? 200, clock: this.clock });
    this.enabled = cfg.verifyOnchain;
    this.tolerance = { ...DEFAULT_TOLERANCE, ...opts.tolerance };

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
   * Re-derive reputation directly from the contract. Returns null on ANY
   * failure/degradation (disabled, RPC down, contract error, truncated client
   * set, or an out-of-range unit) so callers fall back to declared-only.
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
   * The read path WITHOUT the degrade-closed collapse — it distinguishes "this
   * agent genuinely has no on-chain feedback" from "the read failed".
   *
   * `verify()` deliberately flattens both to null so tools never block, but a
   * diagnostic (`doctor`) must not report a failed read as an unrated agent:
   * that turns a broken setup into a green check. Uncached, so a probe always
   * reflects reality now.
   */
  async probe(
    agentId: number,
    opts: { excludeClient?: string } = {},
  ): Promise<VerifyProbe> {
    if (!this.isEnabled) return { ok: false, reason: "disabled" };
    const client = this.client!;
    try {
      const { clients, truncated } = await this.allClients(agentId, opts.excludeClient);
      if (truncated) {
        // Cannot fully account for the client set → don't risk a false mismatch.
        this.logger.debug("client set truncated; degrading to unavailable", { agentId });
        return { ok: false, reason: "truncated" };
      }
      if (clients.length === 0) {
        return { ok: true, value: { average: 0, count: 0, uniqueClients: null } };
      }

      const tx = await client.get_summary({
        agent_id: agentId,
        client_addresses: clients,
        tag1: "",
        tag2: "",
      });
      const res = tx.result;
      if (res.isErr()) {
        this.logger.debug("get_summary returned Err", { agentId });
        return { ok: false, reason: "contract-error" };
      }
      const summary: SummaryResult = res.unwrap();

      const average = this.wadToScale(summary.summary_value, Number(summary.summary_value_decimals));
      if (average == null) {
        this.logger.debug("summary average out of range; degrading", { agentId });
        return { ok: false, reason: "out-of-range" };
      }

      return {
        ok: true,
        value: { average, count: Number(summary.count), uniqueClients: null },
      };
    } catch (err) {
      const body = classifyError(err);
      this.logger.debug("on-chain verify failed; degrading to unavailable", {
        agentId,
        errorCode: body.code,
      });
      return { ok: false, reason: "rpc-error", detail: body.error };
    }
  }

  /**
   * Read a bounded client set compatible with `get_summary`'s five-client cap.
   *
   * The canonical indexed score excludes owner self-feedback. The reputation
   * contract stores that client and includes it unless the caller removes it,
   * so comparison callers pass the owner as `excludeClient`. We scan six raw
   * clients: an exact six-client set remains comparable when one is the owner.
   * A seventh raw client necessarily leaves at least six after one exclusion,
   * so the result must degrade closed.
   */
  private async allClients(
    agentId: number,
    excludeClient?: string,
  ): Promise<{ clients: string[]; truncated: boolean }> {
    const client = this.client!;
    const firstTx = await client.get_clients_paginated({
      agent_id: agentId,
      start: 0,
      limit: CLIENT_SCAN_PAGE,
    });
    const first = firstTx.result ?? [];
    const raw = first.slice(0, CLIENT_SCAN_PAGE);

    // Always probe a second bounded index range. The contract compacts its
    // returned vector by skipping missing/expired ClientAtIndex keys, so a
    // short first vector does NOT prove that later indices are absent. Scanning
    // six more indices catches holes at the cap boundary without making an
    // attacker-controlled, unbounded Soroban simulation.
    const boundaryTx = await client.get_clients_paginated({
      agent_id: agentId,
      start: CLIENT_SCAN_PAGE,
      limit: CLIENT_SCAN_PAGE,
    });
    if ((boundaryTx.result ?? []).length > 0) {
      return { clients: [], truncated: true };
    }

    const excluded = excludeClient?.trim();
    const comparable = excluded ? raw.filter((address) => address !== excluded) : raw;
    if (comparable.length > SUMMARY_CLIENT_CAP) {
      return { clients: [], truncated: true };
    }
    return { clients: comparable, truncated: false };
  }

  /**
   * Convert a WAD-normalized on-chain value to a signed decimal with three
   * places, using bigint division before the Number boundary. Negative values
   * are protocol-valid. Values whose milliscale integer is not exactly
   * representable in JavaScript degrade closed instead of producing a rounded
   * comparison that looks authoritative.
   */
  private wadToScale(value: bigint, decimals: number): number | null {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 40) return null;
    const denom = 10n ** BigInt(decimals);
    const scaledMilli = (value * 1000n) / denom;
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    if (scaledMilli > maxSafe || scaledMilli < -maxSafe) return null;
    const scaled = Number(scaledMilli) / 1000;
    if (!Number.isFinite(scaled)) return null;
    return scaled;
  }

  // --- declared-vs-on-chain diff --------------------------------------------

  /**
   * Bounded verification for one agent against the explorer's DECLARED reputation.
   * - `opts.skip` (or verification disabled) → status "skipped" (e.g. out of top-K).
   * - on-chain null → "unavailable".
   * - average/count within tolerance → "partial" because active uniqueClients
   *   is not derivable from the contract's append-only client list.
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

    const dCount = Math.abs(declared.feedbackCount - onchain.count);
    const dUnique = null;

    // Nothing declared to verify: an agent with no declared reputation cannot be
    // "verified". A null declared average previously forced avgWithin=true, so an
    // unrated agent (declared null, on-chain empty) was wrongly reported
    // "verified". Distinguish the two real
    // cases instead: on-chain is also empty → "unavailable" (no signal either
    // side); on-chain HAS feedback the indexer doesn't → "mismatch".
    if (declared.average == null) {
      const chainEmpty =
        onchain.average === 0 && onchain.count === 0;
      return {
        ...snapshotContext(),
        status: chainEmpty ? "unavailable" : "mismatch",
        declared,
        verified: onchain,
        deltas: { average: 0, count: dCount, uniqueClients: dUnique },
        reason: chainEmpty
          ? "no-reputation-signal"
          : "declared-onchain-diff-unversioned-snapshots",
        verifiedFields: ["average", "feedbackCount"],
        unverifiedFields: ["uniqueClients"],
        checkedAt,
      };
    }

    // Precision-normalize before comparing. The on-chain get_summary average is
    // commonly integer-scaled (the contract truncates the mean, decimals=0 → e.g.
    // 96) while the indexer reports a fractional mean (96.75). Comparing the raw
    // values would false-flag a healthy agent by up to <1.0. When the on-chain
    // value is an integer, compare the declared value truncated to that same integer
    // precision (toward zero, matching Rust integer division). The fractional part is not independently verifiable against an
    // integer summary); otherwise compare directly. This keeps the tolerance TIGHT
    // and scale-independent while still catching a real ≥1-point divergence.
    const declaredForCmp = Number.isInteger(onchain.average)
      ? Math.trunc(declared.average)
      : declared.average;
    const dAvg = Math.abs(declaredForCmp - onchain.average);

    // get_summary covers average + non-revoked feedback count. The contract's
    // client-address list is append-only across revocations, so it cannot verify
    // the indexer's active uniqueClients metric. A healthy comparison is partial
    // and intentionally earns no full-verification ranking bonus.
    const avgWithin = dAvg <= this.tolerance.average;
    const countWithin = dCount <= this.tolerance.feedbackCount;
    const within = avgWithin && countWithin;

    return {
      ...snapshotContext(),
      status: within ? "partial" : "mismatch",
      declared,
      verified: onchain,
      deltas: { average: dAvg, count: dCount, uniqueClients: dUnique },
      reason: within
        ? "bounded-average-count-agreement-unversioned-snapshots"
        : "declared-onchain-diff-unversioned-snapshots",
      verifiedFields: ["average", "feedbackCount"],
      unverifiedFields: ["uniqueClients"],
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
