/**
 * validation.ts — Provider Standard conformance evidence from the Stellar 8004
 * Validation Registry, as badges.
 *
 * A Provider Standard verifier answers a provider's validation request with
 * `validation_response(response = score, response_hash = sha256(receipt),
 * tag = "provider-standard-v1")`. The score is fixed per conformance level
 * (0/33/67/100 for levels 0–3), so a record alone says which level that verifier
 * attested, and therefore which level badges it earns: Standard v1, Payment
 * verified, Recovery verified (docs/verification.md in Stellar Agent Services).
 *
 * Whose word counts is the reader's choice, as ERC-8004 intends: only validators
 * the operator lists in TRUSTED_VALIDATORS earn badges, and never a validator
 * that is the agent's own owner or wallet (the registry would accept such an
 * answer, but it proves nothing). With no trusted validator configured nothing
 * is read at all.
 *
 * What a record cannot say, this does not claim. Load-safe (C7) and 8004
 * validated (C2) are decided by the receipt's results, and the registry stores
 * only the receipt's hash: its URL lives in a contract event, which a public RPC
 * keeps for days, not for good. Those two badges are therefore not derived here,
 * and every attested result says so (RECEIPT_BADGES_NOT_DERIVED).
 *
 * Read-only and fail-closed: simulations on the fetch-only transport in
 * soroban.ts, and any failed read makes the whole result `unavailable`, never a
 * partial set of badges.
 */

import type { Config } from "../config.js";
import { systemClock, type Clock } from "./clock.js";
import { TtlCache } from "./explorer.js";
import { validWalletOrNull } from "./identifier.js";
import { log, type Logger } from "./logger.js";
import { createValidationReadClient, type ValidationReadClient } from "./soroban.js";
import type { Network } from "../types.js";

/** The tag every Provider Standard verifier publishes under (erc-compatibility.md, T2). */
export const VALIDATION_TAG = "provider-standard-v1";

export type ConformanceLevel = 0 | 1 | 2 | 3;

/** The on-chain `response` for each conformance level: higher is better. */
const LEVEL_BY_SCORE: ReadonlyMap<number, ConformanceLevel> = new Map([
  [0, 0],
  [33, 1],
  [67, 2],
  [100, 3],
]);

export type BadgeId = "standard-v1" | "payment-verified" | "recovery-verified";

const BADGES: ReadonlyArray<{ id: BadgeId; label: string; level: ConformanceLevel }> = [
  { id: "standard-v1", label: "Standard v1", level: 1 },
  { id: "payment-verified", label: "Payment verified", level: 2 },
  { id: "recovery-verified", label: "Recovery verified", level: 3 },
];

/** Limitation: TRUSTED_VALIDATORS is empty, so the registry was not read. */
export const NO_TRUSTED_VALIDATORS = "no-trusted-validators";
/** Limitation: Load-safe and 8004 validated need the receipt, which the registry holds only as a hash. */
export const RECEIPT_BADGES_NOT_DERIVED = "receipt-badges-not-derived";
/** Limitation: the agent has more requests than one read scans; newer ones were not seen. */
export const SCAN_TRUNCATED = "validation-scan-truncated";
/** Limitation: trusted records exist that the bounded status reads did not reach. */
export const RECORDS_NOT_LOCATED = "trusted-records-not-located";
/** Limitation: a trusted validator that is the agent's owner or wallet was ignored. */
export const SELF_VALIDATION_IGNORED = "self-validation-ignored";
/** Limitation: a trusted record's response is not one of the standard's level scores. */
export const NONSTANDARD_SCORE_IGNORED = "nonstandard-score-ignored";

const PAGE_SIZE = 20;
const DEFAULT_MAX_SCAN_PAGES = 5;
const DEFAULT_MAX_STATUS_READS = 20;
const READ_CONCURRENCY = 4;
const TTL_MS = 60_000;

export interface ValidationBadge {
  id: BadgeId;
  label: string;
  /** Badges always name their network, so testnet evidence never passes for mainnet. */
  network: Network;
}

/** One answered `provider-standard-v1` record for the agent. */
export interface ValidationRecordView {
  /** Lowercase hex. */
  requestHash: string;
  validator: string;
  /** Listed in TRUSTED_VALIDATORS. */
  trusted: boolean;
  /** The validator is the agent's owner or wallet; such a record earns nothing. */
  selfValidated: boolean;
  /** 0–100, higher is better. */
  response: number;
  /** The level `response` stands for; null when it is not a level score. */
  level: ConformanceLevel | null;
  /** sha256 of the verification receipt, lowercase hex. */
  responseHash: string;
  /** Ledger of the record's last change. */
  ledger: number;
}

export type ValidationStatusKind = "attested" | "none" | "not-configured" | "unavailable";

export interface ValidationEvidence {
  status: ValidationStatusKind;
  tag: typeof VALIDATION_TAG;
  /** How many validators the operator trusts. */
  trustedValidators: number;
  /** Answered records by trusted validators, as the contract's get_summary counts them; null when not read. */
  trustedRecordCount: number | null;
  /** The newest record that earns badges: trusted, not self-validated, with a level score. */
  latest: ValidationRecordView | null;
  /** Every answered record with this tag that the bounded read reached, newest first. */
  records: ValidationRecordView[];
  level: ConformanceLevel | null;
  badges: ValidationBadge[];
  limitations: string[];
  /** Why the result is unavailable. */
  reason?: string;
}

export interface ValidationEvidenceOptions {
  client?: ValidationReadClient;
  cache?: TtlCache;
  clock?: Clock;
  logger?: Logger;
}

/** How much one read may cost; a runtime policy can lower both. */
export interface ValidationReadBudget {
  /** Pages of 20 request hashes to scan (default 5). */
  maxScanPages?: number;
  /** Records whose status to fetch (default 20). */
  maxStatusReads?: number;
}

interface RawRecord {
  requestHash: string;
  validator: string;
  response: number;
  responseHash: string;
  ledger: number;
}

interface RawScan {
  trustedRecordCount: number;
  records: RawRecord[];
  truncated: boolean;
  located: boolean;
}

export class ValidationEvidenceReader {
  private readonly trusted: ReadonlySet<string>;
  private readonly network: Network;
  private readonly cfg: Config;
  private readonly injected: ValidationReadClient | undefined;
  private client: ValidationReadClient | undefined;
  private readonly cache: TtlCache;
  private readonly logger: Logger;

  constructor(cfg: Config, opts: ValidationEvidenceOptions = {}) {
    this.cfg = cfg;
    this.trusted = new Set(cfg.trustedValidators);
    this.network = cfg.network;
    this.injected = opts.client;
    this.cache = opts.cache ?? new TtlCache({ maxEntries: 200, clock: opts.clock ?? systemClock });
    this.logger = (opts.logger ?? log).child({ component: "validation" });
  }

  /** The agent's conformance evidence. `owner` and `wallet` identify self-validation. */
  async read(
    agentId: number,
    who: { owner: string; wallet: string | null },
    budget: ValidationReadBudget = {},
  ): Promise<ValidationEvidence> {
    const base: Pick<ValidationEvidence, "tag" | "trustedValidators" | "latest" | "records" | "level" | "badges"> = {
      tag: VALIDATION_TAG,
      trustedValidators: this.trusted.size,
      latest: null,
      records: [],
      level: null,
      badges: [],
    };
    if (this.trusted.size === 0) {
      return { ...base, status: "not-configured", trustedRecordCount: null, limitations: [NO_TRUSTED_VALIDATORS] };
    }

    const pages = Math.max(1, budget.maxScanPages ?? DEFAULT_MAX_SCAN_PAGES);
    const reads = Math.max(1, budget.maxStatusReads ?? DEFAULT_MAX_STATUS_READS);
    let scan: RawScan;
    try {
      scan = await this.cache.wrap(`validation:${agentId}:${pages}:${reads}`, TTL_MS, () =>
        this.scan(agentId, pages, reads),
      );
    } catch (error) {
      this.logger.warn("validation registry read failed", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ...base,
        status: "unavailable",
        trustedRecordCount: null,
        limitations: [],
        reason: "the Validation Registry could not be read",
      };
    }

    const records = scan.records.map((r) => this.view(r, who));
    const limitations: string[] = [];
    if (scan.truncated) limitations.push(SCAN_TRUNCATED);
    if (!scan.located) limitations.push(RECORDS_NOT_LOCATED);
    if (records.some((r) => r.trusted && r.selfValidated)) limitations.push(SELF_VALIDATION_IGNORED);
    if (records.some((r) => r.trusted && !r.selfValidated && r.level === null)) {
      limitations.push(NONSTANDARD_SCORE_IGNORED);
    }

    // Records are newest first, and a validator may update its answer, so the
    // highest ledger wins; the stable sort keeps registry order for ties.
    const latest =
      [...records]
        .filter((r) => r.trusted && !r.selfValidated && r.level !== null)
        .sort((a, b) => b.ledger - a.ledger)[0] ?? null;

    if (latest === null) {
      // Trusted records exist but none was read: the evidence is unknown, not absent.
      const unknown = scan.trustedRecordCount > 0 && !scan.located;
      return {
        ...base,
        status: unknown ? "unavailable" : "none",
        trustedRecordCount: scan.trustedRecordCount,
        records,
        limitations,
        ...(unknown ? { reason: "trusted records exist beyond the bounded read" } : {}),
      };
    }

    const level = latest.level!;
    return {
      ...base,
      status: "attested",
      trustedRecordCount: scan.trustedRecordCount,
      latest,
      records,
      level,
      badges: BADGES.filter((b) => level >= b.level).map((b) => ({ id: b.id, label: b.label, network: this.network })),
      limitations: [...limitations, RECEIPT_BADGES_NOT_DERIVED],
    };
  }

  private view(raw: RawRecord, who: { owner: string; wallet: string | null }): ValidationRecordView {
    return {
      ...raw,
      trusted: this.trusted.has(raw.validator),
      selfValidated: raw.validator === who.owner || raw.validator === who.wallet,
      level: LEVEL_BY_SCORE.get(raw.response) ?? null,
    };
  }

  private validationClient(): ValidationReadClient {
    this.client ??=
      this.injected ??
      createValidationReadClient(this.cfg, this.cfg.simSource ? { simSource: this.cfg.simSource } : {});
    return this.client;
  }

  /**
   * One bounded pass: count the trusted records (get_summary), then, when there
   * are any, scan the agent's request hashes and read statuses newest first
   * until every trusted record is found or the read budget is spent.
   */
  private async scan(agentId: number, maxScanPages: number, maxStatusReads: number): Promise<RawScan> {
    const client = this.validationClient();
    const summary = await client.get_summary({
      agent_id: agentId,
      validator_addresses: [...this.trusted],
      tag: VALIDATION_TAG,
    });
    const trustedRecordCount = Number(summary.result.count);
    if (trustedRecordCount === 0) return { trustedRecordCount, records: [], truncated: false, located: true };

    const hashes: Buffer[] = [];
    let truncated = true;
    for (let page = 0; page < maxScanPages; page++) {
      const batch = (
        await client.get_agent_validations_paginated({ agent_id: agentId, start: page * PAGE_SIZE, limit: PAGE_SIZE })
      ).result;
      hashes.push(...batch);
      if (batch.length < PAGE_SIZE) {
        truncated = false;
        break;
      }
    }

    const newestFirst = hashes.reverse().slice(0, maxStatusReads);
    const records: RawRecord[] = [];
    let trustedFound = 0;
    for (let i = 0; i < newestFirst.length && trustedFound < trustedRecordCount; i += READ_CONCURRENCY) {
      const batch = newestFirst.slice(i, i + READ_CONCURRENCY);
      const statuses = await Promise.all(
        batch.map((hash) => client.get_validation_status({ request_hash: hash }).then((tx) => tx.result)),
      );
      statuses.forEach((result, j) => {
        if (!result.isOk()) return;
        const status = result.unwrap();
        if (!status.has_response || status.agent_id !== agentId || status.tag !== VALIDATION_TAG) return;
        const validator = validWalletOrNull(status.validator_address);
        if (validator === null) return;
        if (this.trusted.has(validator)) trustedFound++;
        records.push({
          requestHash: toHex(batch[j]!),
          validator,
          response: status.response,
          responseHash: toHex(status.response_hash),
          ledger: Number(status.last_update),
        });
      });
    }
    return { trustedRecordCount, records, truncated, located: trustedFound >= trustedRecordCount };
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
