/**
 * reputation.ts — ReputationVerifier: trust-minimized, on-chain re-derivation
 * of an agent's reputation and a declared-vs-verified diff (the headline edge).
 *
 * This is READ-ONLY. It uses the SDK's `ReputationClient` bindings which
 * auto-simulate: the read result lives on the returned
 * `AssembledTransaction.result`. There is NO signing, NO keypair, NO write —
 * the client is constructed with a source public key used only as the
 * simulation origin. (modules/01 §2.4.2 + §3.4.)
 *
 * Flow per agent:
 *   1. get_clients_paginated(agent_id, start, limit) → paginate the full client
 *      set (bounded by a hard cap to keep cost predictable).
 *   2. get_summary(agent_id, client_addresses, "", "") → WAD-normalized average
 *      across those clients: average = summary_value / 10^summary_value_decimals.
 *   3. diff vs the explorer's DECLARED {average, feedbackCount, uniqueClients}
 *      within tolerance → VerificationStatus.
 *
 * DEGRADE-CLOSED: any RPC failure, simulation rejection, contract error, a
 * truncated (capped) client set, or an out-of-range unit maps to null →
 * status "unavailable". We never block a tool and never emit a false
 * "mismatch" when the on-chain value cannot be trusted. Verification is
 * bounded (top-K agents, decided by the caller; ~10-min cache).
 */

import { ReputationClient, type SummaryResult } from "@trionlabs/stellar8004";
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

/** Client-set pagination page size and hard cap (bounds get_summary cost). */
const CLIENTS_PAGE = 100;
const CLIENTS_HARD_CAP = 1_000;

/** Cache TTLs (ms): verified values live ~10 min; degraded results retry sooner. */
const TTL_OK = 600_000;
const TTL_NEGATIVE = 60_000;

/** Declared-vs-on-chain tolerances (modules/01 §3, DEFAULTS.VERIFY_TOLERANCE). */
export interface VerifyTolerance {
  average: number;
  count: number;
  uniqueClients: number;
}
// average tolerance 1.0: the on-chain get_summary average is INTEGER-scaled
// (summary_value_decimals=0 → e.g. 96) while the indexer reports a FRACTIONAL
// mean (e.g. 96.75), so a healthy agent differs by up to <1.0 purely from the
// contract truncating. 0.5 was too tight and false-flagged such agents. Verified
// live: Scrapper on-chain 96 vs declared 96.75 (Δ0.75) is a match, not a mismatch.
export const DEFAULT_TOLERANCE: VerifyTolerance = { average: 1.0, count: 1, uniqueClients: 1 };

export interface ReputationVerifierOptions {
  clock?: Clock;
  logger?: Logger;
  /** Inject a pre-built binding (tests). */
  client?: ReputationClient;
  /** Read-simulation source G-address (else RANK_SIM_SOURCE / default). */
  simSource?: string;
  tolerance?: Partial<VerifyTolerance>;
  maxCacheEntries?: number;
}

export class ReputationVerifier {
  private readonly client: ReputationClient | null;
  private readonly cache: TtlCache;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly scoreMax: number;
  private readonly tolerance: VerifyTolerance;

  constructor(cfg: Config, opts: ReputationVerifierOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.logger = (opts.logger ?? log).child({ component: "reputation" });
    this.cache = new TtlCache({ maxEntries: opts.maxCacheEntries ?? 200, clock: this.clock });
    this.enabled = cfg.verifyOnchain;
    this.scoreMax = cfg.scoreMax;
    this.tolerance = { ...DEFAULT_TOLERANCE, ...opts.tolerance };

    if (!this.enabled) {
      this.client = null;
    } else if (opts.client) {
      this.client = opts.client;
    } else {
      // Only pass a publicKey when the operator explicitly provides a funded
      // source; otherwise omit it so the SDK uses its fabricated NULL_ACCOUNT and
      // skips the getAccount() lookup that would otherwise fail on public RPCs.
      const simSource = opts.simSource ?? process.env.RANK_SIM_SOURCE?.trim();
      this.client = new ReputationClient({
        contractId: cfg.stellar.contracts.reputation,
        networkPassphrase: cfg.stellar.networkPassphrase,
        rpcUrl: cfg.rpcUrl,
        ...(simSource ? { publicKey: simSource } : {}),
        allowHttp: cfg.rpcUrl.startsWith("http://"),
      });
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
   * Bounded + cached (10 min for a value, 60 s for a null).
   */
  async verify(agentId: number): Promise<OnchainReputation | null> {
    if (!this.isEnabled) return null;
    return this.cache.wrap<OnchainReputation | null>(
      `rep:${agentId}`,
      (value) => (value == null ? TTL_NEGATIVE : TTL_OK),
      () => this.deriveOnchain(agentId),
    );
  }

  private async deriveOnchain(agentId: number): Promise<OnchainReputation | null> {
    const client = this.client!;
    try {
      const { clients, truncated } = await this.allClients(agentId);
      if (truncated) {
        // Cannot fully account for the client set → don't risk a false mismatch.
        this.logger.debug("client set truncated; degrading to unavailable", { agentId });
        return null;
      }
      if (clients.length === 0) {
        return { average: 0, count: 0, uniqueClients: 0 };
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
        return null;
      }
      const summary: SummaryResult = res.unwrap();

      const average = this.wadToScale(summary.summary_value, Number(summary.summary_value_decimals));
      if (average == null) {
        this.logger.debug("summary average out of range; degrading", { agentId });
        return null;
      }

      return {
        average,
        count: Number(summary.count),
        uniqueClients: clients.length,
      };
    } catch (err) {
      const body = classifyError(err);
      this.logger.debug("on-chain verify failed; degrading to unavailable", {
        agentId,
        errorCode: body.code,
      });
      return null;
    }
  }

  /** Paginate get_clients_paginated. `truncated` = hit the hard cap without
   *  reaching the end (client set too large to fully verify cheaply). */
  private async allClients(agentId: number): Promise<{ clients: string[]; truncated: boolean }> {
    const client = this.client!;
    const out: string[] = [];
    // `<=` so we make one probe fetch AT the cap boundary: an agent with exactly
    // CLIENTS_HARD_CAP clients returns full pages up to the cap, then an empty
    // page at `start == CLIENTS_HARD_CAP` proving the set is complete. Without the
    // probe, exactly-cap client sets were wrongly flagged truncated → "unavailable".
    for (let start = 0; start <= CLIENTS_HARD_CAP; start += CLIENTS_PAGE) {
      const tx = await client.get_clients_paginated({
        agent_id: agentId,
        start,
        limit: CLIENTS_PAGE,
      });
      const page = tx.result ?? [];
      out.push(...page);
      if (page.length < CLIENTS_PAGE) return { clients: out, truncated: false };
    }
    return { clients: out, truncated: true };
  }

  /**
   * Convert a WAD-normalized on-chain value to the 0..scoreMax scale, keeping
   * 3 decimals via bigint division (avoids Number precision loss on i128).
   * Returns null for a nonsensical unit (likely a scale mismatch) so the caller
   * degrades to "unavailable" instead of asserting a false "mismatch".
   */
  private wadToScale(value: bigint, decimals: number): number | null {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 40) return null;
    const denom = 10n ** BigInt(decimals);
    const scaled = Number((value * 1000n) / denom) / 1000;
    if (!Number.isFinite(scaled)) return null;
    // On-chain average should sit on the declared 0..scoreMax scale. A value far
    // outside that band signals a unit mismatch, not a real divergence.
    if (scaled < -0.001 || scaled > this.scoreMax * 5) return null;
    return scaled;
  }

  // --- declared-vs-verified diff --------------------------------------------

  /**
   * Full verification for one agent against the explorer's DECLARED reputation.
   * - `opts.skip` (or verification disabled) → status "skipped" (e.g. out of top-K).
   * - on-chain null → "unavailable".
   * - within tolerance → "verified"; else "mismatch" (flag only, no penalty).
   */
  async verifyAgainst(
    agentId: number,
    declared: DeclaredReputation,
    opts: { skip?: boolean } = {},
  ): Promise<VerificationResult> {
    const checkedAt = this.clock.nowIso();

    if (!this.isEnabled || opts.skip) {
      return { status: "skipped", declared, checkedAt };
    }

    const onchain = await this.verify(agentId);
    if (onchain == null) {
      return { status: "unavailable", declared, checkedAt };
    }

    const dCount = Math.abs(declared.feedbackCount - onchain.count);
    const dUnique = Math.abs(declared.uniqueClients - onchain.uniqueClients);

    // Nothing declared to verify: an agent with no declared reputation cannot be
    // "verified". A null declared average previously forced avgWithin=true, so an
    // unrated agent (declared null, on-chain empty) was wrongly reported
    // "verified" and earned the +P_VERIFIED rank bonus. Distinguish the two real
    // cases instead: on-chain is also empty → "unavailable" (no signal either
    // side); on-chain HAS feedback the indexer doesn't → "mismatch".
    if (declared.average == null) {
      const chainEmpty =
        onchain.average === 0 && onchain.count === 0 && onchain.uniqueClients === 0;
      return {
        status: chainEmpty ? "unavailable" : "mismatch",
        declared,
        verified: onchain,
        deltas: { average: 0, count: dCount, uniqueClients: dUnique },
        checkedAt,
      };
    }

    const dAvg = Math.abs(declared.average - onchain.average);

    // Drive verified/mismatch off the AVERAGE (the reputation signal) and the
    // UNIQUE-CLIENT count (both should agree). The on-chain `get_summary.count` has
    // ambiguous semantics vs the indexer's per-feedback count (it aggregates over
    // the CLIENT list), so a feedbackCount-vs-count mismatch is common on a healthy
    // agent (e.g. Scrapper: 8 feedback / 4 clients). Report it as an informational
    // delta only — never a mismatch trigger — to avoid false negatives.
    const avgWithin = dAvg <= this.tolerance.average;
    const uniqueWithin = dUnique <= this.tolerance.uniqueClients;
    const within = avgWithin && uniqueWithin;

    return {
      status: within ? "verified" : "mismatch",
      declared,
      verified: onchain,
      deltas: { average: dAvg, count: dCount, uniqueClients: dUnique },
      checkedAt,
    };
  }

  /** Build a "skipped" result without any RPC (caller decided out of top-K). */
  skipped(declared: DeclaredReputation): VerificationResult {
    return { status: "skipped", declared, checkedAt: this.clock.nowIso() };
  }

  /** Test/utility: drop the verification cache. */
  clearCache(): void {
    this.cache.clear();
  }
}
