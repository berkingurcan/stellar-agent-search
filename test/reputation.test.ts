/**
 * reputation.test.ts — ReputationVerifier.verifyAgainst over an INJECTED fake
 * ReputationClient (no RPC). Pins the declared-vs-verified decision logic, in
 * particular the fix that an UNRATED agent is never reported "verified".
 */

import { describe, it, expect } from "vitest";
import type { ReputationClient } from "@trionlabs/stellar8004";
import { loadConfig } from "../src/config.js";
import { ReputationVerifier } from "../src/lib/reputation.js";
import type { DeclaredReputation } from "../src/types.js";

const cfg = loadConfig({ STELLAR_NETWORK: "mainnet", VERIFY_ONCHAIN: "true" } as NodeJS.ProcessEnv);

/**
 * Build a fake binding: `clients` is the full on-chain client set (returned on
 * the first page, then empty), and `avg` is the on-chain get_summary average.
 */
function fakeClient(clients: string[], avg: number): ReputationClient {
  return {
    get_clients_paginated: async ({ start }: { start: number }) => ({
      result: start === 0 ? clients : [],
    }),
    get_summary: async () => ({
      result: {
        isErr: () => false,
        unwrap: () => ({
          summary_value: BigInt(avg),
          summary_value_decimals: 0,
          count: BigInt(clients.length),
        }),
      },
    }),
  } as unknown as ReputationClient;
}

const C = (n: number) => Array.from({ length: n }, (_, i) => `GCLIENT${i}`);

describe("verifyAgainst: unrated agent is never 'verified' (rep-#4)", () => {
  it("declared null + on-chain empty → 'unavailable' (nothing to verify, NO bonus)", async () => {
    const v = new ReputationVerifier(cfg, { client: fakeClient([], 0) });
    const declared: DeclaredReputation = { average: null, feedbackCount: 0, uniqueClients: 0 };
    const res = await v.verifyAgainst(1, declared);
    expect(res.status).not.toBe("verified");
    expect(res.status).toBe("unavailable");
  });

  it("declared null but on-chain HAS feedback → 'mismatch'", async () => {
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 90) });
    const declared: DeclaredReputation = { average: null, feedbackCount: 0, uniqueClients: 0 };
    const res = await v.verifyAgainst(2, declared);
    expect(res.status).toBe("mismatch");
    expect(res.verified?.uniqueClients).toBe(4);
  });
});

describe("verifyAgainst: rated agent (rep sanity)", () => {
  it("declared matches on-chain within tolerance → 'verified'", async () => {
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 90) });
    const declared: DeclaredReputation = { average: 90, feedbackCount: 8, uniqueClients: 4 };
    const res = await v.verifyAgainst(3, declared);
    expect(res.status).toBe("verified");
    expect(res.verified?.average).toBe(90);
  });

  it("declared diverges from on-chain beyond tolerance → 'mismatch'", async () => {
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 40) });
    const declared: DeclaredReputation = { average: 90, feedbackCount: 8, uniqueClients: 4 };
    const res = await v.verifyAgainst(4, declared);
    expect(res.status).toBe("mismatch");
  });

  it("absorbs integer-vs-fractional average (contract 96 vs indexer 96.75) → 'verified'", async () => {
    // The real Scrapper case: on-chain get_summary is integer-scaled (96) while
    // the indexer reports 96.75. The 0.75 gap is a representation artifact, not a
    // mismatch — declared is floored to the on-chain integer precision at compare
    // time. Verified live on mainnet during the R7 fix.
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 96) });
    const declared: DeclaredReputation = { average: 96.75, feedbackCount: 8, uniqueClients: 4 };
    const res = await v.verifyAgainst(10, declared);
    expect(res.status).toBe("verified");
  });

  it("still catches a real >=1-point divergence after normalization", async () => {
    // 94 declared vs 96 on-chain (both plausibly integer-scaled) is a genuine
    // 2-point gap — floor(94)=94 vs 96 → mismatch, not masked by normalization.
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 96) });
    const declared: DeclaredReputation = { average: 94, feedbackCount: 8, uniqueClients: 4 };
    const res = await v.verifyAgainst(11, declared);
    expect(res.status).toBe("mismatch");
  });
});

describe("construction: R7 no-account read path (rep-#11 guard)", () => {
  it("constructs a real ReputationClient with no publicKey and stays enabled", () => {
    // Guards the R7 fix: omitting publicKey must still yield an ENABLED verifier
    // (the SDK fabricates NULL_ACCOUNT internally, no getAccount lookup). If a
    // future SDK version requires a source account at construction, this fails
    // loudly here instead of silently degrading every verify to "unavailable".
    const v = new ReputationVerifier(cfg); // no injected client → real binding path
    expect(v.isEnabled).toBe(true);
  });
});
