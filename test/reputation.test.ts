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
import { TtlCache } from "../src/lib/explorer.js";
import { ReputationVerifier } from "../src/lib/reputation.js";
import type { Clock } from "../src/lib/clock.js";
import type { DeclaredReputation } from "../src/types.js";

const cfg = loadConfig({ STELLAR_NETWORK: "mainnet", VERIFY_ONCHAIN: "true" } as NodeJS.ProcessEnv);

/**
 * Build a fake binding: `clients` is the full on-chain client set (returned on
 * the first page, then empty), and `avg` is the on-chain get_summary average.
 */
function fakeClient(clients: string[], avg: number, feedbackCount = clients.length): ReputationClient {
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
          count: BigInt(feedbackCount),
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
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 90, 8) });
    const declared: DeclaredReputation = { average: null, feedbackCount: 0, uniqueClients: 0 };
    const res = await v.verifyAgainst(2, declared);
    expect(res.status).toBe("mismatch");
    expect(res.verified?.uniqueClients).toBeNull();
  });
});

describe("verifyAgainst: rated agent (rep sanity)", () => {
  it("preserves the real chain-read time when a verification cache entry is reused", async () => {
    let now = Date.parse("2026-07-29T12:00:00.000Z");
    const clock: Clock = {
      now: () => now,
      nowIso: () => new Date(now).toISOString(),
    };
    const cache = new TtlCache({ clock });
    const declared: DeclaredReputation = { average: 90, feedbackCount: 4, uniqueClients: 4 };
    const first = new ReputationVerifier(cfg, { cache, clock, client: fakeClient(C(4), 90) });

    const initial = await first.verifyAgainst(70, declared);
    now += 5 * 60_000;
    const cached = await first.verifyAgainst(70, declared);

    expect(initial.checkedAt).toBe("2026-07-29T12:00:00.000Z");
    expect(cached.checkedAt).toBe(initial.checkedAt);
  });

  it("shares actor-neutral Soroban results across request-scoped verifiers", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const counted = (counter: () => void, avg: number): ReputationClient => ({
      get_clients_paginated: async () => {
        counter();
        return { result: C(4) };
      },
      get_summary: async () => {
        counter();
        return {
          result: {
            isErr: () => false,
            unwrap: () => ({ summary_value: BigInt(avg), summary_value_decimals: 0, count: 4n }),
          },
        };
      },
    }) as unknown as ReputationClient;
    const cache = new TtlCache();
    const first = new ReputationVerifier(cfg, {
      cache,
      client: counted(() => firstCalls++, 91),
    });
    const second = new ReputationVerifier(cfg, {
      cache,
      client: counted(() => secondCalls++, 12),
    });

    expect((await first.verify(77))?.average).toBe(91);
    expect((await second.verify(77))?.average).toBe(91);
    expect(firstCalls).toBe(2);
    expect(secondCalls).toBe(0);
  });

  it("declared average/count match → 'partial' because uniqueClients is not derivable", async () => {
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 90, 8) });
    const declared: DeclaredReputation = { average: 90, feedbackCount: 8, uniqueClients: 4 };
    const res = await v.verifyAgainst(3, declared);
    expect(res.status).toBe("partial");
    expect(res.verifiedFields).toEqual(["average", "feedbackCount"]);
    expect(res.unverifiedFields).toEqual(["uniqueClients"]);
    expect(res.verified?.average).toBe(90);
  });

  it("declared diverges from on-chain beyond tolerance → 'mismatch'", async () => {
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 40, 8) });
    const declared: DeclaredReputation = { average: 90, feedbackCount: 8, uniqueClients: 4 };
    const res = await v.verifyAgainst(4, declared);
    expect(res.status).toBe("mismatch");
  });

  it("does not verify an inflated declared feedback volume", async () => {
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 90, 4) });
    const declared: DeclaredReputation = { average: 90, feedbackCount: 40, uniqueClients: 4 };
    const res = await v.verifyAgainst(5, declared);
    expect(res.status).toBe("mismatch");
    expect(res.deltas?.count).toBe(36);
    expect(res.verifiedFields).toEqual(["average", "feedbackCount"]);
  });

  it("absorbs integer-vs-fractional average but remains partial", async () => {
    // The real Scrapper case: on-chain get_summary is integer-scaled (96) while
    // the indexer reports 96.75. The 0.75 gap is a representation artifact, not a
    // mismatch — declared is truncated to the on-chain integer precision at compare
    // time. Verified live on mainnet during the R7 fix.
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 96, 8) });
    const declared: DeclaredReputation = { average: 96.75, feedbackCount: 8, uniqueClients: 4 };
    const res = await v.verifyAgainst(10, declared);
    expect(res.status).toBe("partial");
  });

  it("still catches a real >=1-point divergence after normalization", async () => {
    // 94 declared vs 96 on-chain (both plausibly integer-scaled) is a genuine
    // 2-point gap — trunc(94)=94 vs 96 → mismatch, not masked by normalization.
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 96, 8) });
    const declared: DeclaredReputation = { average: 94, feedbackCount: 8, uniqueClients: 4 };
    const res = await v.verifyAgainst(11, declared);
    expect(res.status).toBe("mismatch");
  });

  it("uses contract-style truncation toward zero for negative integer summaries", async () => {
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), -1, 4) });
    const declared: DeclaredReputation = { average: -1.75, feedbackCount: 4, uniqueClients: 4 };
    const res = await v.verifyAgainst(15, declared);
    expect(res.status).toBe("partial");
    expect(res.deltas?.average).toBe(0);
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
    if (p.ok) expect(p.value).toEqual({ average: 0, count: 0, uniqueClients: null });
  });

  it("rated agent → ok, carrying the on-chain figures", async () => {
    const v = new ReputationVerifier(cfg, { client: fakeClient(C(4), 96) });
    const p = await v.probe(10);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value).toEqual({ average: 96, count: 4, uniqueClients: null });
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
    const result = await new ReputationVerifier(off, { client: fakeClient(C(4), 96) }).verifyAgainst(
      10,
      { average: 96, feedbackCount: 4, uniqueClients: 4 },
    );
    expect(result).toMatchObject({ status: "skipped", reason: "disabled" });
  });

  it("accepts exactly five clients without exceeding the contract cap", async () => {
    const all = C(5);
    const client = {
      get_clients_paginated: async ({ start, limit }: { start: number; limit: number }) => ({
        result: all.slice(start, start + limit),
      }),
      get_summary: async () => ({
        result: {
          isErr: () => false,
          unwrap: () => ({ summary_value: 90n, summary_value_decimals: 0, count: 5n }),
        },
      }),
    } as unknown as ReputationClient;
    const p = await new ReputationVerifier(cfg, { client }).probe(12);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value.uniqueClients).toBeNull();
  });

  it("excludes owner self-feedback to match the canonical indexed score", async () => {
    const owner = "GOWNER";
    const all = [owner, ...C(5)];
    let summarized: string[] = [];
    const client = {
      get_clients_paginated: async ({ start, limit }: { start: number; limit: number }) => ({
        result: all.slice(start, start + limit),
      }),
      get_summary: async ({ client_addresses }: { client_addresses: string[] }) => {
        summarized = client_addresses;
        return {
          result: {
            isErr: () => false,
            unwrap: () => ({ summary_value: 90n, summary_value_decimals: 0, count: 5n }),
          },
        };
      },
    } as unknown as ReputationClient;

    const declared: DeclaredReputation = { average: 90, feedbackCount: 5, uniqueClients: 5 };
    const result = await new ReputationVerifier(cfg, { client }).verifyAgainst(14, declared, {
      excludeClient: owner,
    });
    expect(result.status).toBe("partial");
    expect(summarized).toEqual(C(5));
  });

  it("degrades closed when the cap probe returns even a short overflow page", async () => {
    const all = C(6);
    const client = {
      get_clients_paginated: async ({ start, limit }: { start: number; limit: number }) => ({
        result: all.slice(start, start + limit),
      }),
      get_summary: async () => {
        throw new Error("must not summarize a truncated client set");
      },
    } as unknown as ReputationClient;
    const p = await new ReputationVerifier(cfg, { client }).probe(13);
    expect(p).toEqual({ ok: false, reason: "truncated" });
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
