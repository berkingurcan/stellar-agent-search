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
});
