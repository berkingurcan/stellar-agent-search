/**
 * Discovery correctness regressions: bounded-scan coverage, server-side MPP,
 * and list_services' explicit explorer page size. Fully offline.
 */

import { describe, expect, it } from "vitest";
import type { AgentResponse } from "@trionlabs/stellar8004";
import { loadConfig, type Config } from "../src/config.js";
import { ExplorerService } from "../src/lib/explorer.js";
import { ReputationVerifier } from "../src/lib/reputation.js";
import { registerFindAgent } from "../src/tools/find_agent.js";
import { registerLeaderboard } from "../src/tools/leaderboard.js";
import { registerListAgents } from "../src/tools/list_agents.js";
import { registerListServices } from "../src/tools/list_services.js";
import { registerRankAgent } from "../src/tools/rank_agent.js";
import type { ToolDeps } from "../src/tools/shared.js";
import { collectFeedbackWindow } from "../src/tools/shared.js";

const OWNER = "GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V";

interface MockResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

function jsonResponse(body: unknown): MockResponse {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: async () => body,
  };
}

function agent(id: number, name = `Scraper ${id}`): AgentResponse {
  return {
    id,
    name,
    description: "scrapes web pages",
    owner: OWNER,
    x402Enabled: false,
    mppEnabled: true,
    hasServices: true,
    feedbackCount: id,
    avgScore: 80,
    uniqueClients: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as AgentResponse;
}

function pageBody(
  agents: AgentResponse[],
  opts: { page?: number; limit?: number; total?: number; hasMore?: boolean; pagination?: boolean } = {},
) {
  return {
    success: true,
    data: agents,
    meta: {
      version: "1",
      chain: "stellar",
      network: "mainnet",
      timestamp: "now",
      requestId: "test",
      ...(opts.pagination === false
        ? {}
        : {
            pagination: {
              page: opts.page ?? 1,
              limit: opts.limit ?? 50,
              total: opts.total ?? agents.length,
              hasMore: opts.hasMore ?? false,
            },
          }),
    },
  };
}

class MockFetch {
  readonly calls: URL[] = [];

  constructor(
    private readonly responder: (url: URL) => MockResponse | Promise<MockResponse>,
  ) {}

  get fn(): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof URL ? input : new URL(String(input));
      this.calls.push(url);
      return this.responder(url) as unknown as Response;
    }) as typeof fetch;
  }
}

function config(): Config {
  return loadConfig({
    STELLAR_NETWORK: "mainnet",
    VERIFY_ONCHAIN: "false",
  } as NodeJS.ProcessEnv);
}

function depsWith(mock: MockFetch): ToolDeps {
  const cfg = config();
  return {
    config: cfg,
    explorer: new ExplorerService(cfg, { fetch: mock.fn }),
    verifier: new ReputationVerifier(cfg),
  };
}

function captureHandler(
  register: (server: any, deps: ToolDeps) => void,
  toolName: string,
  deps: ToolDeps,
): (args: any) => Promise<any> {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  register(
    {
      registerTool(name: string, _definition: unknown, handler: (args: any) => Promise<any>) {
        handlers.set(name, handler);
      },
    },
    deps,
  );
  const handler = handlers.get(toolName);
  if (!handler) throw new Error(`${toolName} was not registered`);
  return handler;
}

describe("ExplorerService bounded discovery coverage", () => {
  it("reports a partial page window honestly and forwards the current API's mpp filter", async () => {
    const mock = new MockFetch((url) => {
      const page = Number(url.searchParams.get("page"));
      return jsonResponse(
        pageBody(
          page === 1
            ? [agent(1), { ...agent(2, "Translator"), description: "language translation" }]
            : [agent(1), agent(3)],
          { page, total: 100, hasMore: true },
        ),
      );
    });
    const explorer = new ExplorerService(config(), { fetch: mock.fn });

    const result = await explorer.findAgentsWithCoverage("scraper", {
      filters: { limit: 50, mpp: true },
      pages: 2,
      match: "any",
    });

    expect(result.agents.map((a) => a.id)).toEqual([1, 3]);
    expect(result.coverage).toEqual({
      coverageComplete: false,
      paginationExhausted: false,
      snapshotConsistent: false,
      pagesScanned: 2,
      recordsScanned: 4,
      hasMore: true,
      limitations: ["v1-unversioned-offset-pagination"],
    });
    expect(mock.calls).toHaveLength(2);
    for (const url of mock.calls) {
      expect(url.pathname).toBe("/api/v1/agents");
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.get("mpp")).toBe("true");
    }
  });

  it("reports v1 exhaustion without claiming snapshot-complete coverage", async () => {
    const completeMock = new MockFetch(() =>
      jsonResponse(pageBody([agent(1)], { hasMore: false })),
    );
    const complete = await new ExplorerService(config(), {
      fetch: completeMock.fn,
    }).findAgentsWithCoverage("");
    expect(complete.coverage).toEqual({
      coverageComplete: false,
      paginationExhausted: true,
      snapshotConsistent: false,
      pagesScanned: 1,
      recordsScanned: 1,
      hasMore: false,
      limitations: ["v1-unversioned-offset-pagination"],
    });

    const unknownMock = new MockFetch(() =>
      jsonResponse(pageBody([agent(1)], { pagination: false })),
    );
    const unknown = await new ExplorerService(config(), {
      fetch: unknownMock.fn,
    }).findAgentsWithCoverage("");
    expect(unknown.coverage).toEqual({
      coverageComplete: false,
      paginationExhausted: false,
      snapshotConsistent: false,
      pagesScanned: 1,
      recordsScanned: 1,
      limitations: [
        "v1-unversioned-offset-pagination",
        "pagination-metadata-unavailable",
      ],
    });
    expect(unknown.coverage).not.toHaveProperty("hasMore");
  });
});

describe("feedback pagination windows", () => {
  it("applies caller page/limit over visible rows rather than upstream 20-row pages", async () => {
    const mock = new MockFetch((url) => {
      const page = Number(url.searchParams.get("page"));
      const start = (page - 1) * 20 + 1;
      const data = Array.from({ length: 20 }, (_, index) => ({
        feedbackIndex: start + index,
        clientAddress: "GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V",
        value: 90,
        valueDecimals: 0,
        tag1: null,
        tag2: null,
        endpoint: null,
        feedbackUri: null,
        isRevoked: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        responses: [],
      }));
      return jsonResponse(
        pageBody(data as unknown as AgentResponse[], { page, total: 60, hasMore: page < 3 }),
      );
    });
    const deps = depsWith(mock);

    const secondTen = await collectFeedbackWindow(deps, 10, {
      page: 2,
      limit: 10,
      includeRevoked: false,
    });
    expect(secondTen.rows.map((row) => row.feedbackIndex)).toEqual(
      Array.from({ length: 10 }, (_, index) => 11 + index),
    );
    expect(secondTen.coverage).toMatchObject({ windowComplete: true, pagesScanned: 1 });

    const firstTwentyFive = await collectFeedbackWindow(deps, 11, {
      page: 1,
      limit: 25,
      includeRevoked: false,
    });
    expect(firstTwentyFive.rows).toHaveLength(25);
    expect(firstTwentyFive.rows.at(-1)?.feedbackIndex).toBe(25);
    expect(firstTwentyFive.coverage.pagesScanned).toBe(2);
  });
});

describe("tool discovery contracts", () => {
  it("rejects ambiguous legacy minScore before any Explorer request", async () => {
    const mock = new MockFetch(() => jsonResponse(pageBody([])));
    const find = captureHandler(registerFindAgent, "find_agent", depsWith(mock));

    const result = await find({
      query: "scraper",
      minScore: 50,
      limit: 10,
      sortBy: "relevance",
      verify: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/minScore.*ambiguous.*minExplorerScore/);
    expect(mock.calls).toHaveLength(0);
  });

  it("forwards explicit minExplorerScore to the upstream minScore parameter", async () => {
    const mock = new MockFetch(() =>
      jsonResponse(pageBody([agent(10)], { total: 1, hasMore: false })),
    );
    const find = captureHandler(registerFindAgent, "find_agent", depsWith(mock));

    const result = await find({
      query: "scraper",
      minExplorerScore: 250,
      limit: 10,
      sortBy: "relevance",
      verify: false,
    });

    expect(result.isError).toBeFalsy();
    expect(mock.calls[0]?.searchParams.get("minScore")).toBe("250");
  });

  it("rejects retired per-call ranking weights before any Explorer request", async () => {
    const mock = new MockFetch(() => jsonResponse(pageBody([])));
    const rank = captureHandler(registerRankAgent, "rank_agent", depsWith(mock));

    const result = await rank({
      agentIds: [10],
      weights: { breadth: 1 },
      limit: 10,
      sortBy: "relevance",
      verify: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/weights.*no longer supported.*volume=0\.4/);
    expect(mock.calls).toHaveLength(0);
  });

  it("list_agents forwards MPP to one list request and never detail-hydrates candidates", async () => {
    const mock = new MockFetch(() =>
      jsonResponse(pageBody([agent(8), agent(9)], { total: 2, hasMore: false })),
    );
    const list = captureHandler(registerListAgents, "list_agents", depsWith(mock));

    const result = await list({
      mpp: true,
      limit: 20,
      page: 1,
      sortBy: "score",
      verify: false,
    });

    expect(result.isError).toBeFalsy();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].pathname).toBe("/api/v1/agents");
    expect(mock.calls[0].searchParams.get("mpp")).toBe("true");
  });

  it("leaderboard forwards MPP into its bounded list scan without per-agent fan-out", async () => {
    const mock = new MockFetch(() =>
      jsonResponse(pageBody([agent(20), agent(21)], { total: 2, hasMore: false })),
    );
    const leaderboard = captureHandler(registerLeaderboard, "leaderboard", depsWith(mock));

    const result = await leaderboard({ mpp: true, limit: 10, verify: false });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.coverage).toEqual({
      coverageComplete: false,
      paginationExhausted: true,
      snapshotConsistent: false,
      pagesScanned: 1,
      recordsScanned: 2,
      hasMore: false,
      limitations: ["v1-unversioned-offset-pagination"],
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].pathname).toBe("/api/v1/agents");
    expect(mock.calls[0].searchParams.get("mpp")).toBe("true");
  });

  it("find_agent pushes MPP into the list query without detail hydration and returns coverage", async () => {
    const mock = new MockFetch(() =>
      jsonResponse(pageBody([agent(10)], { total: 1, hasMore: false })),
    );
    const find = captureHandler(registerFindAgent, "find_agent", depsWith(mock));

    const result = await find({
      query: "scraper",
      limit: 10,
      mpp: true,
      sortBy: "relevance",
      verify: false,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.coverage).toEqual({
      coverageComplete: false,
      paginationExhausted: true,
      snapshotConsistent: false,
      pagesScanned: 1,
      recordsScanned: 1,
      hasMore: false,
      limitations: ["v1-unversioned-offset-pagination"],
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].pathname).toBe("/api/v1/agents");
    expect(mock.calls[0].searchParams.get("mpp")).toBe("true");
  });

  it("query-based rank_agent uses server-side MPP and exposes the bounded scan", async () => {
    const mock = new MockFetch(() =>
      jsonResponse(pageBody([agent(11)], { total: 100, hasMore: true })),
    );
    const rank = captureHandler(registerRankAgent, "rank_agent", depsWith(mock));

    const result = await rank({
      query: "mpp scraper",
      limit: 10,
      sortBy: "relevance",
      verify: false,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.coverage).toEqual({
      coverageComplete: false,
      paginationExhausted: false,
      snapshotConsistent: false,
      pagesScanned: 2,
      recordsScanned: 2,
      hasMore: true,
      limitations: ["v1-unversioned-offset-pagination"],
    });
    expect(mock.calls).toHaveLength(2);
    for (const url of mock.calls) {
      expect(url.pathname).toBe("/api/v1/agents");
      expect(url.searchParams.get("mpp")).toBe("true");
    }
  });

  it("list_services pins limit=50 and hydrates only its server-filtered MPP window", async () => {
    const mock = new MockFetch((url) => {
      const detail = url.pathname.match(/^\/api\/v1\/agents\/(\d+)$/);
      if (detail) {
        const id = Number(detail[1]);
        return jsonResponse({
          ...pageBody([], { pagination: false }),
          data: {
            ...agent(id),
            services: [{ name: `service-${id}`, endpoint: `https://agent-${id}.example/run` }],
          },
        });
      }

      const page = Number(url.searchParams.get("page"));
      return jsonResponse(
        pageBody(page === 1 ? [agent(1), agent(2)] : [agent(3), agent(4)], {
          page,
          total: 100,
          hasMore: true,
        }),
      );
    });
    const list = captureHandler(registerListServices, "list_services", depsWith(mock));

    const result = await list({
      search: "",
      mpp: true,
      limit: 2,
      page: 1,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.services).toHaveLength(2);
    expect(result.structuredContent.coverage).toEqual({
      coverageComplete: false,
      paginationExhausted: false,
      snapshotConsistent: false,
      pagesScanned: 2,
      recordsScanned: 4,
      hasMore: true,
      hydrationMissing: 0,
      detailsHydrated: 2,
      limitations: [
        "v1-unversioned-offset-pagination",
        "detail-hydration-unversioned",
      ],
    });

    const listCalls = mock.calls.filter((url) => url.pathname === "/api/v1/agents");
    const detailCalls = mock.calls.filter((url) => /\/api\/v1\/agents\/\d+$/.test(url.pathname));
    expect(listCalls).toHaveLength(2);
    expect(detailCalls).toHaveLength(2);
    for (const url of listCalls) {
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.get("mpp")).toBe("true");
      expect(url.searchParams.get("hasServices")).toBe("true");
    }
  });
});
