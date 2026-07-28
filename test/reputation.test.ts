/**
 * reputation.test.ts — ReputationVerifier.verifyAgainst over an INJECTED fake
 * ReputationClient (no RPC). Pins the declared-vs-verified decision logic, in
 * particular the fix that an UNRATED agent is never reported "verified".
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("probe(): a failed read is distinguishable from an unrated agent", () => {
  it("empty client set → ok, with zeroed value (genuinely unrated)", async () => {
    const v = new ReputationVerifier(cfg, { client: fakeClient([], 0) });
    const p = await v.probe(10);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value).toEqual({ average: 0, count: 0, uniqueClients: 0 });
  });

  it("rated agent → ok, carrying the on-chain figures", async () => {
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 96) });
    const p = await v.probe(10);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value).toEqual({ average: 96, count: 4, uniqueClients: 4 });
  });

  it("transport failure → NOT ok, reason 'rpc-error' — never mistaken for 'no data'", async () => {
    const throwing = {
      get_clients_paginated: async () => {
        throw new Error("Request failed with status code 405");
      },
      get_summary: async () => {
        throw new Error("unreachable");
      },
    } as unknown as ReputationClient;

    const v = new ReputationVerifier(cfg, { client: throwing });
    const p = await v.probe(10);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("rpc-error");

    // verify() still degrades closed to null — the tool-facing contract is unchanged.
    expect(await v.verify(10)).toBeNull();
  });

  it("contract Err → reason 'contract-error', not a silent empty summary", async () => {
    const erring = {
      get_clients_paginated: async ({ start }: { start: number }) => ({
        result: start === 0 ? C(2) : [],
      }),
      get_summary: async () => ({ result: { isErr: () => true, unwrap: () => undefined } }),
    } as unknown as ReputationClient;

    const p = await new ReputationVerifier(cfg, { client: erring }).probe(10);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("contract-error");
  });

  it("verification disabled → reason 'disabled'", async () => {
    const off = loadConfig({ STELLAR_NETWORK: "mainnet", VERIFY_ONCHAIN: "false" } as NodeJS.ProcessEnv);
    const p = await new ReputationVerifier(off, { client: fakeClient(C(4), 96) }).probe(10);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("disabled");
  });
});

describe("on-chain reads never fall back to the axios transport (soroban.ts)", () => {
  // The generated bindings' Client constructor MUTATES the options object it is
  // given, writing back an axios-backed rpc.Server under `options.server`. The
  // no-axios Client honours a pre-set `options.server`, so sharing one object
  // between the spec donor and the real client silently reinstates axios for
  // every read. It typechecks, it passes offline tests, and it fails only
  // against a live proxy with a 405 — so it has to be pinned here.
  it("gives the reader its own options object, not the donor's", async () => {
    const { createReputationReadClient } = await import("../src/lib/soroban.js");
    const cfg = {
      network: "mainnet",
      stellar: {
        contracts: { reputation: "CBOIAIMMWAXI57OATLX6BWVDQLCC4YU55HV6MZXFRP6CBSGAMXSTEPPA" },
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      },
      rpcUrl: "https://mainnet.sorobanrpc.com",
    } as unknown as Parameters<typeof createReputationReadClient>[0];

    const client = createReputationReadClient(cfg) as unknown as {
      options: { server: unknown };
    };

    const server = client.options.server as { constructor: { name: string } } | undefined;
    expect(server, "reader should have built its own rpc server").toBeTruthy();

    // The fetch-based build's Server carries no axios instance. The axios build's
    // Server exposes one; asserting its absence is what catches the shared-options
    // regression, whichever way the SDK names its internals.
    const asRecord = server as unknown as Record<string, unknown>;
    const looksAxios = Object.values(asRecord).some(
      (v) => typeof v === "function" && "defaults" in (v as object) && "interceptors" in (v as object),
    );
    expect(looksAxios, "reader is using the axios transport").toBe(false);
  });
});

describe("the no-axios subpath this build depends on still exists", () => {
  // stellar-sdk INVERTED this layout in v16: the default build became
  // fetch-based and axios moved behind an explicit `./axios` subpath, so
  // `./no-axios/*` — which src/lib/soroban.ts imports — does not exist there.
  //   v15: .  ./contract  ./rpc  ./no-axios  ./no-axios/contract  ./no-axios/rpc
  //   v16: .  ./contract  ./rpc  ./axios     ./axios/contract     ./axios/rpc
  // We pin ^15, so this is fine today. Bumping to ^16 must switch soroban.ts to
  // the plain `./contract` subpath (already fetch-based there) — and this test
  // is what turns that into a red build instead of a runtime resolution error.
  it("resolves @stellar/stellar-sdk/no-axios/contract under the pinned major", async () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(
      pkg.dependencies["@stellar/stellar-sdk"],
      "soroban.ts imports ./no-axios/*, which v16 removed — see the comment above",
    ).toMatch(/\^?15/);

    await expect(import("@stellar/stellar-sdk/no-axios/contract")).resolves.toBeDefined();
  });
});
