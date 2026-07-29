/** Fail-closed reputation reads over an injected binding (no RPC). */

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

const C = (n: number) => Array.from({ length: n }, (_, i) => `GCLIENT${i}`);

function fakeClient(
  page: (args: { start: number; limit: number }) => string[] = () => [],
): { client: ReputationClient; calls: Array<{ start: number; limit: number }>; summaryCalls: () => number } {
  const calls: Array<{ start: number; limit: number }> = [];
  let summaries = 0;
  const client = {
    get_clients_paginated: async ({ start, limit }: { start: number; limit: number }) => {
      calls.push({ start, limit });
      return { result: page({ start, limit }) };
    },
    get_summary: async () => {
      summaries++;
      throw new Error("get_summary must remain unreachable without an exhaustion proof");
    },
  } as unknown as ReputationClient;
  return { client, calls, summaryCalls: () => summaries };
}

describe("fail-closed client-set exhaustion", () => {
  it("separates a healthy contract read path from reputation comparability", async () => {
    const fake = fakeClient(() => C(4));
    const verifier = new ReputationVerifier(cfg, { client: fake.client });

    expect(await verifier.probeReachability(10)).toEqual({
      ok: true,
      observedClients: 4,
      start: 0,
      limit: 6,
    });
    expect(fake.calls).toEqual([{ start: 0, limit: 6 }]);
    expect(fake.summaryCalls()).toBe(0);
  });

  it("treats even an empty observed list as unprovable and never summarizes", async () => {
    const fake = fakeClient(() => []);
    const verifier = new ReputationVerifier(cfg, { client: fake.client });

    expect(await verifier.probe(10)).toEqual({
      ok: false,
      reason: "client-set-exhaustion-unprovable",
    });
    expect(fake.calls).toEqual([{ start: 0, limit: 6 }]);
    expect(fake.summaryCalls()).toBe(0);
  });

  it("does not let a hole at index 6 hide a retained client at index 7", async () => {
    const retained = new Map<number, string>([
      [0, "GCLIENT0"],
      [1, "GCLIENT1"],
      [2, "GCLIENT2"],
      [3, "GCLIENT3"],
      [4, "GCLIENT4"],
      // Index 6 is expired/missing; index 7 is still retained.
      [7, "GCLIENT7"],
    ]);
    const fake = fakeClient(({ start, limit }) => {
      const rows: string[] = [];
      for (let index = start; index < Math.min(start + limit, 8); index++) {
        const client = retained.get(index);
        if (client) rows.push(client);
      }
      return rows;
    });

    const result = await new ReputationVerifier(cfg, { client: fake.client }).verifyAgainst(17, {
      average: 90,
      feedbackCount: 5,
      uniqueClients: 5,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "client-set-exhaustion-unprovable",
      snapshotComparable: false,
      verifiedFields: [],
      unverifiedFields: ["average", "feedbackCount", "uniqueClients"],
    });
    expect(result).not.toHaveProperty("verified");
    expect(result).not.toHaveProperty("deltas");
    expect(result.limitations.join(" ")).toMatch(/cannot prove exhaustive client history/i);
    expect(fake.summaryCalls()).toBe(0);
  });

  it("caches the degraded observation for 60 seconds, then refreshes it", async () => {
    let now = Date.parse("2026-07-29T12:00:00.000Z");
    const clock: Clock = {
      now: () => now,
      nowIso: () => new Date(now).toISOString(),
    };
    const cache = new TtlCache({ clock });
    const declared: DeclaredReputation = { average: 90, feedbackCount: 4, uniqueClients: 4 };
    const fake = fakeClient(() => C(4));
    const first = new ReputationVerifier(cfg, { cache, clock, client: fake.client });

    const initial = await first.verifyAgainst(70, declared);
    now += 59_000;
    const cached = await first.verifyAgainst(70, declared);
    now += 1_000;
    const refreshed = await first.verifyAgainst(70, declared);

    expect(initial.checkedAt).toBe("2026-07-29T12:00:00.000Z");
    expect(cached.checkedAt).toBe(initial.checkedAt);
    expect(refreshed.checkedAt).toBe("2026-07-29T12:01:00.000Z");
    expect(fake.calls).toHaveLength(2);
    expect(fake.summaryCalls()).toBe(0);
  });

  it("shares the actor-neutral degraded observation across request-scoped verifiers", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const counted = (counter: () => void): ReputationClient => ({
      get_clients_paginated: async () => {
        counter();
        return { result: C(4) };
      },
      get_summary: async () => {
        throw new Error("must not summarize");
      },
    }) as unknown as ReputationClient;
    const cache = new TtlCache();
    const first = new ReputationVerifier(cfg, {
      cache,
      client: counted(() => firstCalls++),
    });
    const second = new ReputationVerifier(cfg, {
      cache,
      client: counted(() => secondCalls++),
    });

    expect(await first.verify(77)).toBeNull();
    expect(await second.verify(77)).toBeNull();
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
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

describe("probe(): transport and configuration failures remain distinguishable", () => {
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
    const reachability = await v.probeReachability(10);
    expect(reachability.ok).toBe(false);
    if (!reachability.ok) expect(reachability.reason).toBe("rpc-error");
    const p = await v.probe(10);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("rpc-error");

    // verify() still degrades closed to null — the tool-facing contract is unchanged.
    expect(await v.verify(10)).toBeNull();
  });

  it("verification disabled → reason 'disabled'", async () => {
    const off = loadConfig({ STELLAR_NETWORK: "mainnet", VERIFY_ONCHAIN: "false" } as NodeJS.ProcessEnv);
    const fake = fakeClient(() => C(4));
    const reachability = await new ReputationVerifier(off, { client: fake.client }).probeReachability(10);
    expect(reachability).toEqual({ ok: false, reason: "disabled" });
    const p = await new ReputationVerifier(off, { client: fake.client }).probe(10);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("disabled");
    const result = await new ReputationVerifier(off, { client: fake.client }).verifyAgainst(
      10,
      { average: 96, feedbackCount: 4, uniqueClients: 4 },
    );
    expect(result).toMatchObject({
      status: "skipped",
      reason: "disabled",
      snapshotComparable: false,
    });
    expect(fake.calls).toHaveLength(0);
    expect(fake.summaryCalls()).toBe(0);
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
