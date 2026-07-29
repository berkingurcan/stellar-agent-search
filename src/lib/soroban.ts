/**
 * soroban.ts — the on-chain read transport, on a fetch-only Stellar SDK build.
 *
 * WHY THIS FILE EXISTS
 *
 * `@trionlabs/stellar8004@0.0.11` was published against Stellar SDK v15, whose
 * default `contract.Client` used axios. Two consequences reached users of the
 * published package, and neither could be fixed for consumers by this root
 * project's `overrides` block:
 *
 *   1. `@stellar/stellar-sdk@15.1.0` pins axios to the exact version `1.15.0`,
 *      which carries two high-severity advisories.
 *   2. axios below 1.16.1 issues a plain-HTTP (non-`CONNECT`) request for an
 *      `https://` URL when a proxy is configured; proxies answer with **405**.
 *      The visible symptom is on-chain verification reporting `unavailable`
 *      while the explorer and RPC health checks pass — the one feature this
 *      server exists for, silently degraded on any proxied network.
 *
 * Stellar SDK v16 inverted that layout: its default `./contract` and `./rpc`
 * exports are fetch-based, while axios is opt-in under `./axios/*`. The root
 * dependency and the exact-pinned generated bindings are forced onto one v16
 * instance during development/build; the latter is embedded into the bin.
 *
 * WHAT THIS DOES
 *
 * Rather than hand-rolling the contract ABI — the decoding is money-adjacent and
 * a re-implementation would be a second source of truth for it — we borrow the
 * generated bindings' `Spec` and hand it to the v16 fetch `Client`. Identical
 * argument encoding and result decoding, different transport:
 *
 *     new ReputationClient(...)  ->  .spec  ->  new FetchContractClient(spec, opts)
 *
 * The donor is constructed but never used for I/O; building it costs no network
 * call, and the spec it carries is the same XDR the contract was compiled from.
 * If the contract's interface changes, both sides move together on the next
 * `@trionlabs/stellar8004` bump — there is no copy here to go stale.
 *
 * Still read-only and keyless: simulation only, no signing, and no `publicKey`
 * unless the operator supplies a funded source, so the SDK fabricates
 * NULL_ACCOUNT and skips the `getAccount()` lookup public RPCs reject.
 */

import { ReputationClient, type SummaryResult } from "@trionlabs/stellar8004";
import { Client as FetchContractClient } from "@stellar/stellar-sdk/contract";
import type { Config } from "../config.js";

/**
 * The two reads `ReputationVerifier` performs, in the shape the generated
 * bindings return them. Declaring it structurally keeps the verifier's injection
 * seam open for test fakes, which never touch the network.
 */
export interface ReputationReadClient {
  get_summary(args: {
    agent_id: number;
    client_addresses: string[];
    tag1: string;
    tag2: string;
  }): Promise<{ result: { isErr(): boolean; unwrap(): SummaryResult } }>;

  get_clients_paginated(args: {
    agent_id: number;
    start: number;
    limit: number;
  }): Promise<{ result: string[] | undefined }>;
}

export interface ReputationReadClientOptions {
  /**
   * Source account for simulation. Omit (the default) so the SDK uses its
   * fabricated NULL_ACCOUNT — no funded account, no `getAccount()` round-trip.
   * Only set this to force a specific funded source.
   */
  simSource?: string;
}

/**
 * Build the Reputation contract reader on the fetch-based SDK build.
 *
 * Throws only if the bindings or the SDK are unusable, which is a packaging
 * fault rather than a runtime condition — callers treat a construction failure
 * the same as a disabled verifier.
 */
export function createReputationReadClient(
  cfg: Config,
  opts: ReputationReadClientOptions = {},
): ReputationReadClient {
  const clientOptions = () => ({
    contractId: cfg.stellar.contracts.reputation,
    networkPassphrase: cfg.stellar.networkPassphrase,
    rpcUrl: cfg.rpcUrl,
    allowHttp: cfg.rpcUrl.startsWith("http://"),
    ...(opts.simSource ? { publicKey: opts.simSource } : {}),
  });

  // Donor: constructed for its exact generated `spec` only. No I/O happens
  // here, but the constructor mutates its options object by installing a
  // transport server. Keep the donor and reader options separate so generated
  // binding construction cannot smuggle transport state into the read client.
  const spec = new ReputationClient(clientOptions()).spec;

  const common = clientOptions();

  // The generated package and our direct dependency declare `Spec` through
  // separate package boundaries. Its private field can therefore remain
  // nominally distinct to TypeScript even though the override resolves both to
  // one v16 implementation. This structural cast is safe: `Spec` contains
  // parsed XDR entries and no transport state.
  const ContractClient = FetchContractClient as unknown as new (
    spec: unknown,
    options: typeof common,
  ) => ReputationReadClient;

  return new ContractClient(spec, common);
}
