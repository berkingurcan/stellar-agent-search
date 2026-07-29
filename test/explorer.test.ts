/**
 * explorer.test.ts — ExplorerService over a MOCKED fetch (no network).
 *
 * The service wraps the SDK's real ExplorerClient (we inject a fake `fetch`, so
 * the SDK's URL building + response normalization run for real) and adds three
 * things this suite pins down:
 *
 *   1. TTL cache        — repeated identical reads hit fetch once, then re-fetch
 *                         after the TTL lapses (driven by a manual clock).
 *   2. single-flight    — concurrent identical reads collapse to ONE fetch.
 *   3. findAgents()     — discovery fetches getAgents by STRUCTURED filters (path
 *                         /api/v1/agents; NOT the weak /api/v1/search and NOT the
 *                         server `search` param) then STEM-matches client-side over
 *                         name/description/services; multi-page fetch honors hasMore.
 *
 * Runs fully offline in CI.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { AgentResponse } from "@trionlabs/stellar8004";
import { loadConfig, type Config } from "../src/config.js";
import { ExplorerService, TtlCache } from "../src/lib/explorer.js";
import { manualClock } from "../src/lib/clock.js";

// ---------------------------------------------------------------------------
// Mock fetch: records every requested URL and returns canned JSON pages.
// ---------------------------------------------------------------------------

interface MockResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

function jsonResponse(body: unknown, status = 200): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
  };
}

function agentPage(agents: AgentResponse[], opts: { page?: number; total?: number; hasMore?: boolean } = {}) {
  const page = opts.page ?? 1;
  const limit = 50;
  return {
    success: true,
    data: agents,
    meta: {
      version: "1",
      chain: "stellar",
      network: "mainnet",
      timestamp: "now",
      requestId: "t",
      pagination: {
        page,
        limit,
        total: opts.total ?? agents.length,
        hasMore: opts.hasMore ?? false,
      },
    },
  };
}

function agent(id: number, name: string, description = ""): AgentResponse {
  return { id, name, description, owner: `G${id}`, x402Enabled: false } as AgentResponse;
}

/** A controllable mock fetch. Each call resolves via the configured responder. */
class MockFetch {
  calls: URL[] = [];
  private responder: (url: URL) => MockResponse | Promise<MockResponse>;

  constructor(responder: (url: URL) => MockResponse | Promise<MockResponse>) {
    this.responder = responder;
  }

  get fn(): typeof fetch {
    const self = this;
    // `Parameters<typeof fetch>[0]` rather than the DOM's `RequestInfo`: the
    // project's `lib` is ES2022 only, so the DOM global does not exist here.
    return (async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof URL ? input : new URL(String(input));
      self.calls.push(url);
      return self.responder(url) as unknown as Response;
    }) as unknown as typeof fetch;
  }

  paths(): string[] {
    return this.calls.map((u) => u.pathname);
  }
}

let config: Config;
beforeEach(() => {
  config = loadConfig({ STELLAR_NETWORK: "mainnet", VERIFY_ONCHAIN: "false" } as NodeJS.ProcessEnv);
});

// ---------------------------------------------------------------------------

describe("TTL cache", () => {
  it("shares actor-neutral results across request-scoped ExplorerService instances", async () => {
    const cache = new TtlCache();
    const firstFetch = new MockFetch(() => jsonResponse(agentPage([agent(7, "shared")])));
    const secondFetch = new MockFetch(() => jsonResponse(agentPage([agent(99, "must-not-run")])));
    const first = new ExplorerService(config, { fetch: firstFetch.fn, cache });
    const second = new ExplorerService(config, { fetch: secondFetch.fn, cache });

    expect((await first.getAgents({ limit: 50 })).data[0].id).toBe(7);
    expect((await second.getAgents({ limit: 50 })).data[0].id).toBe(7);
    expect(firstFetch.calls).toHaveLength(1);
    expect(secondFetch.calls).toHaveLength(0);
  });

  it("serves a repeated identical read from cache (one fetch)", async () => {
    const mock = new MockFetch(() => jsonResponse(agentPage([agent(1, "a")])));
    const svc = new ExplorerService(config, { fetch: mock.fn });

    const a = await svc.getAgents({ limit: 50 });
    const b = await svc.getAgents({ limit: 50 });

    expect(a.data[0].id).toBe(1);
    expect(b.data[0].id).toBe(1);
    expect(mock.calls.length).toBe(1); // second call cached
  });

  it("keys the cache by params — different params re-fetch", async () => {
    const mock = new MockFetch(() => jsonResponse(agentPage([agent(1, "a")])));
    const svc = new ExplorerService(config, { fetch: mock.fn });

    await svc.getAgents({ limit: 50 });
    await svc.getAgents({ limit: 10 }); // distinct params
    expect(mock.calls.length).toBe(2);
  });

  it("re-fetches after the TTL lapses (manual clock)", async () => {
    const clock = manualClock(0);
    const mock = new MockFetch(() => jsonResponse(agentPage([agent(1, "a")])));
    const svc = new ExplorerService(config, { fetch: mock.fn, clock });

    await svc.getAgents({ limit: 50 });
    expect(mock.calls.length).toBe(1);

    clock.advance(10_000); // still within the 30s list TTL
    await svc.getAgents({ limit: 50 });
    expect(mock.calls.length).toBe(1);

    clock.advance(60_000); // now past the TTL
    await svc.getAgents({ limit: 50 });
    expect(mock.calls.length).toBe(2);
  });
});

describe("single-flight", () => {
  it("collapses concurrent identical reads into one fetch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const mock = new MockFetch(async () => {
      await gate; // hold the first (and only) request open
      return jsonResponse(agentPage([agent(1, "a")]));
    });
    const svc = new ExplorerService(config, { fetch: mock.fn });

    const p1 = svc.getAgents({ limit: 50 });
    const p2 = svc.getAgents({ limit: 50 }); // issued before p1 resolves
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.data[0].id).toBe(1);
    expect(r2.data[0].id).toBe(1);
    expect(mock.calls.length).toBe(1); // deduped
  });
});

describe("findAgents discovery primitive", () => {
  it("uses getAgents (/api/v1/agents) — NEVER the weak /api/v1/search", async () => {
    const mock = new MockFetch(() =>
      jsonResponse(agentPage([agent(1, "Web Scraper", "scrapes sites")])),
    );
    const svc = new ExplorerService(config, { fetch: mock.fn });

    await svc.findAgents("scraper");

    expect(mock.paths()).toContain("/api/v1/agents");
    expect(mock.paths().some((p) => p.includes("/search"))).toBe(false);
    // The query is NOT forwarded as the server `search` param (it substring-matches
    // the stored name poorly); matching happens client-side over the candidates.
    expect(mock.calls[0].searchParams.get("search")).toBeNull();
  });

  it("stem-matches so 'scraper'/'scraping' finds the 'Scrapper' agent (flagship gap)", async () => {
    // The real flagship is literally "Scrapper" / "Scrapes URLs…"; a correct-spelling
    // query MUST still find it (the R24 don't-embarrass-the-demo gate, at the tool's
    // own primitive). The prior code forwarded search= and returned [].
    const mock = new MockFetch(() =>
      jsonResponse(
        agentPage([
          agent(10, "Scrapper Agent", "Scrapes URLs and returns structured data"),
          agent(2, "Translator", "language translation"),
        ]),
      ),
    );
    const svc = new ExplorerService(config, { fetch: mock.fn });

    expect((await svc.findAgents("scraper")).map((a) => a.id)).toEqual([10]);
    expect((await svc.findAgents("web scraping")).map((a) => a.id)).toEqual([10]);
  });

  it("filters client-side over name/description (explorer substring match is weak)", async () => {
    // The explorer returns a superset; only true name/description matches survive.
    const mock = new MockFetch(() =>
      jsonResponse(
        agentPage([
          agent(1, "Web Scraper", "scrapes websites"),
          agent(2, "Translator", "language translation"),
          agent(3, "Data Oracle", "on-chain SCRAPER of prices"),
        ]),
      ),
    );
    const svc = new ExplorerService(config, { fetch: mock.fn });

    const hits = await svc.findAgents("scraper");
    const ids = hits.map((a) => a.id).sort();
    expect(ids).toEqual([1, 3]); // id 2 has no "scraper" token; case-insensitive
  });

  it("empty query returns the fetched page unfiltered", async () => {
    const mock = new MockFetch(() =>
      jsonResponse(agentPage([agent(1, "a"), agent(2, "b")])),
    );
    const svc = new ExplorerService(config, { fetch: mock.fn });

    const hits = await svc.findAgents("   ");
    expect(hits.map((a) => a.id).sort()).toEqual([1, 2]);
  });

  it("matches Unicode names accent-insensitively", async () => {
    const mock = new MockFetch(() =>
      jsonResponse(
        agentPage([
          agent(1, "Türkçe Çeviri", "çok dilli çeviri"),
          agent(2, "Price Oracle", "market data"),
        ]),
      ),
    );
    const svc = new ExplorerService(config, { fetch: mock.fn });

    expect((await svc.findAgents("turkce ceviri")).map((a) => a.id)).toEqual([1]);
  });

  it("never treats a nonblank tokenless query as match-all", async () => {
    const mock = new MockFetch(() =>
      jsonResponse(agentPage([agent(1, "a"), agent(2, "b")])),
    );
    const svc = new ExplorerService(config, { fetch: mock.fn });

    const result = await svc.findAgentsWithCoverage("!!!");
    expect(result.agents).toEqual([]);
    expect(result.coverage.coverageComplete).toBe(false);
    expect(result.coverage.limitations).toContain("query-no-search-tokens");
  });

  it("match:'all' still REQUIRES a meaningful 2-char token (ai/ml/db)", async () => {
    // Dropping <3-char stems made match:'all' stop requiring "ai", so "ai agent"
    // wrongly matched a non-AI "Payment Agent". Both tokens must be required.
    const mock = new MockFetch(() =>
      jsonResponse(
        agentPage([
          agent(1, "AI Agent", "an ai assistant"),
          agent(2, "Payment Agent", "handles payments"),
        ]),
      ),
    );
    const svc = new ExplorerService(config, { fetch: mock.fn });

    const hits = await svc.findAgents("ai agent", { match: "all" });
    expect(hits.map((a) => a.id)).toEqual([1]); // #2 lacks "ai"
  });

  it("match:'all' requires every token; match:'any' requires one", async () => {
    const mock = new MockFetch(() =>
      jsonResponse(
        agentPage([
          agent(1, "Fast Web Scraper", "fast scraper"),
          agent(2, "Web Portal", "just web"),
        ]),
      ),
    );
    const svc = new ExplorerService(config, { fetch: mock.fn });

    const all = await svc.findAgents("web scraper", { match: "all" });
    expect(all.map((a) => a.id)).toEqual([1]); // only #1 has both tokens

    const any = await svc.findAgents("web scraper", { match: "any" });
    expect(any.map((a) => a.id).sort()).toEqual([1, 2]); // both have "web"
  });

  it("fetches multiple pages while hasMore, de-dupes by id, stops when exhausted", async () => {
    const mock = new MockFetch((url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      if (page === 1) {
        return jsonResponse(
          agentPage([agent(1, "scraper one"), agent(2, "scraper two")], {
            page: 1,
            total: 3,
            hasMore: true,
          }),
        );
      }
      // page 2 overlaps id 2 (concurrent indexer write) → must be de-duped
      return jsonResponse(
        agentPage([agent(2, "scraper two"), agent(3, "scraper three")], {
          page: 2,
          total: 3,
          hasMore: false,
        }),
      );
    });
    const svc = new ExplorerService(config, { fetch: mock.fn });

    const hits = await svc.findAgents("scraper", { pages: 3 });
    expect(hits.map((a) => a.id).sort()).toEqual([1, 2, 3]); // de-duped
    // Fetched exactly two pages then stopped (page 2 had hasMore=false).
    expect(mock.paths().filter((p) => p === "/api/v1/agents").length).toBe(2);
  });

  it("stops paging early when the first page already signals no more", async () => {
    const mock = new MockFetch(() =>
      jsonResponse(agentPage([agent(1, "scraper")], { page: 1, hasMore: false })),
    );
    const svc = new ExplorerService(config, { fetch: mock.fn });

    await svc.findAgents("scraper", { pages: 5 });
    expect(mock.calls.length).toBe(1); // never fetched page 2
  });
});
