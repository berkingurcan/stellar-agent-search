import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ApiResponse, HealthResponse } from "@trionlabs/stellar8004";
import { loadConfig } from "../src/config.js";
import {
  ExplorerService,
  TtlCache,
  type ExplorerStatsResponse,
} from "../src/lib/explorer.js";
import { classifyError } from "../src/lib/errors.js";
import {
  buildRegistryHealthView,
  buildRegistryStatsView,
} from "../src/lib/registry-stats.js";
import { ReputationVerifier } from "../src/lib/reputation.js";
import { buildServer } from "../src/server.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

const meta = {
  version: "1",
  chain: "stellar",
  network: "mainnet",
  timestamp: "2026-07-29T00:00:00.000Z",
  requestId: "registry-stats-test",
};

const stats: ExplorerStatsResponse = {
  totalAgents: 6_000,
  totalFeedbacks: 900,
  totalValidations: 80,
  totalUniqueClients: 700,
  averageFeedbackScore: 88.4,
  agentsWithServices: 40,
  agentsWithX402: 20,
  agentsWithMpp: 12,
  network: "mainnet",
  protocolDistribution: { a2a: 5, mcp: 8, other: 2 },
  trustDistribution: { reputation: 11, validation: 4, tee: 1 },
};

describe("honest registry stats", () => {
  it("validates the optional MPP count and never labels sampled distributions global", () => {
    const view = buildRegistryStatsView(stats, "mainnet");
    expect(view.agentsWithMpp).toBe(12);
    expect(view.coverage).toMatchObject({
      sampleCapAgents: 5_000,
      sampleSizeKnown: false,
      distributionsGlobalExact: false,
      snapshotConsistent: false,
    });
    expect(view.coverage.sampledMetrics).toContain("totalUniqueClients");
    expect(view.metricDefinitions.totalUniqueClients).toContain("not a global distinct count");
    expect(view.limitations.join(" ")).toContain("not a globally deduplicated client count");

    expect(() =>
      buildRegistryStatsView({ ...stats, agentsWithMpp: -1 }, "mainnet"),
    ).toThrow(/stats\.agentsWithMpp/);

    const { agentsWithMpp: _omitted, ...withoutMpp } = stats;
    const missingMpp = buildRegistryStatsView(withoutMpp, "mainnet");
    expect(missingMpp.agentsWithMpp).toBeNull();
    expect(missingMpp.coverage.exactCountMetrics).not.toContain("agentsWithMpp");
  });

  it.each([
    ["payload", null],
    ["network", { ...stats, network: "testnet" }],
    ["totalAgents", { ...stats, totalAgents: -1 }],
    ["totalFeedbacks", { ...stats, totalFeedbacks: 1.5 }],
    ["totalValidations", { ...stats, totalValidations: Number.MAX_SAFE_INTEGER + 1 }],
    ["totalUniqueClients", { ...stats, totalUniqueClients: Number.NaN }],
    ["averageFeedbackScore", { ...stats, averageFeedbackScore: Number.POSITIVE_INFINITY }],
    ["agentsWithServices", { ...stats, agentsWithServices: -1 }],
    ["agentsWithX402", { ...stats, agentsWithX402: "20" }],
    ["protocolDistribution", { ...stats, protocolDistribution: [] }],
    ["protocolDistribution count", { ...stats, protocolDistribution: { mcp: -1 } }],
    ["trustDistribution", { ...stats, trustDistribution: null }],
    ["trustDistribution count", { ...stats, trustDistribution: { reputation: 1.2 } }],
  ])("rejects malformed stats field %s as upstream data", (_label, payload) => {
    let thrown: unknown;
    try {
      buildRegistryStatsView(payload, "mainnet");
    } catch (error) {
      thrown = error;
    }
    expect(classifyError(thrown)).toMatchObject({
      code: "UPSTREAM_ERROR",
      detail: "malformed explorer payload",
    });
  });

  it.each([
    ["payload", null],
    ["network", { status: "healthy", network: "testnet", indexer: {} }],
    ["status", { status: "garbage", network: "mainnet", indexer: {} }],
    ["indexer", { status: "healthy", network: "mainnet", indexer: [] }],
    [
      "identity ledger",
      {
        status: "healthy",
        network: "mainnet",
        indexer: {
          identity: { lastLedger: -1, stale: false },
          reputation: { lastLedger: 1, stale: false },
          validation: { lastLedger: 1, stale: false },
        },
      },
    ],
    [
      "reputation stale",
      {
        status: "healthy",
        network: "mainnet",
        indexer: {
          identity: { lastLedger: 1, stale: false },
          reputation: { lastLedger: 1, stale: "false" },
          validation: { lastLedger: 1, stale: false },
        },
      },
    ],
    [
      "validation",
      {
        status: "healthy",
        network: "mainnet",
        indexer: {
          identity: { lastLedger: 1, stale: false },
          reputation: { lastLedger: 1, stale: false },
        },
      },
    ],
  ])("rejects malformed health field %s as upstream data", (_label, payload) => {
    let thrown: unknown;
    try {
      buildRegistryHealthView(payload, "mainnet");
    } catch (error) {
      thrown = error;
    }
    expect(classifyError(thrown)).toMatchObject({
      code: "UPSTREAM_ERROR",
      detail: "malformed explorer payload",
    });
  });

  it("exposes definitions and coverage through both the stats tool and registry resource", async () => {
    const config = loadConfig({
      STELLAR_NETWORK: "mainnet",
      VERIFY_ONCHAIN: "false",
    } as NodeJS.ProcessEnv);
    let statsData: unknown = stats;
    let healthData: unknown = {
      status: "healthy",
      network: "mainnet",
      indexer: {
        identity: { lastLedger: 1, stale: false },
        reputation: { lastLedger: 1, stale: false },
        validation: { lastLedger: 1, stale: false },
      },
    };
    const statsResponse = (): ApiResponse<ExplorerStatsResponse> => ({
      success: true,
      data: statsData as ExplorerStatsResponse,
      meta,
    });
    const healthResponse = (): ApiResponse<HealthResponse> => ({
      success: true,
      data: healthData as HealthResponse,
      meta,
    });
    const cache = new TtlCache();
    const explorer = new ExplorerService(config, {
      cache,
      client: {
        getStats: async () => statsResponse(),
        health: async () => healthResponse(),
        getAgent: async (id: number) => ({
          success: true,
          data: {
            id,
            owner: "GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V",
            avgScore: 96.75,
            feedbackCount: 8,
            uniqueClients: 4,
          },
          meta,
        }),
      } as never,
    });
    const server = buildServer(config, {
      version: "test",
      deps: { config, explorer, verifier: new ReputationVerifier(config) },
    });
    const client = new Client(
      { name: "registry-stats-test", version: "test" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(() => client.close(), () => server.close());

    const tool = await client.callTool({ name: "get_registry_stats", arguments: {} });
    expect(tool.isError).toBeFalsy();
    expect(tool.structuredContent).toMatchObject({
      agentsWithMpp: 12,
      coverage: {
        sampleCapAgents: 5_000,
        distributionsGlobalExact: false,
      },
    });
    const statsText = tool.content.find((entry) => entry.type === "text")?.text ?? "";
    expect(statsText).toContain("in upstream protocol units");
    expect(statsText).not.toContain("88.4/100");

    const healthTool = await client.callTool({ name: "get_registry_health", arguments: {} });
    expect(healthTool.isError).toBeFalsy();
    expect(healthTool.structuredContent).toMatchObject({
      network: "mainnet",
      anyStale: false,
      indexer: { identity: { lastLedger: 1, stale: false } },
    });

    const resource = await client.readResource({ uri: "stellar8004://registry" });
    const jsonContent = resource.contents.find(
      (entry) => entry.mimeType === "application/json" && "text" in entry,
    );
    expect(jsonContent).toBeDefined();
    const parsed = JSON.parse((jsonContent as { text: string }).text) as {
      stats: ReturnType<typeof buildRegistryStatsView>;
      health: ReturnType<typeof buildRegistryHealthView>;
    };
    expect(parsed.stats.agentsWithMpp).toBe(12);
    expect(parsed.stats.coverage.distributionsGlobalExact).toBe(false);
    expect(parsed.stats.metricDefinitions.protocolDistribution).toContain("service-entry counts");
    expect(parsed.health).toMatchObject({ network: "mainnet", anyStale: false });

    const reputationResource = await client.readResource({
      uri: "stellar8004://agent/10/reputation",
    });
    const reputationJson = reputationResource.contents.find(
      (entry) => entry.mimeType === "application/json" && "text" in entry,
    );
    const reputationMarkdown = reputationResource.contents.find(
      (entry) => entry.mimeType === "text/markdown" && "text" in entry,
    );
    expect(reputationJson).toBeDefined();
    expect(JSON.parse((reputationJson as { text: string }).text)).toMatchObject({
      status: "skipped",
      reason: "disabled",
      verifiedFields: [],
      unverifiedFields: ["average", "feedbackCount", "uniqueClients"],
      snapshotComparable: false,
      limitations: expect.arrayContaining([expect.stringContaining("client-count/cursor")]),
    });
    expect((reputationMarkdown as { text: string }).text).toContain("reason: disabled");
    expect((reputationMarkdown as { text: string }).text).toContain("verifiedFields: none");
    expect((reputationMarkdown as { text: string }).text).toContain("limitations:");

    statsData = { ...stats, totalAgents: -1 };
    cache.clear();
    const badStatsTool = await client.callTool({ name: "get_registry_stats", arguments: {} });
    expect(badStatsTool.isError).toBe(true);
    expect(JSON.parse(badStatsTool.content[0]?.type === "text" ? badStatsTool.content[0].text : "{}"))
      .toMatchObject({ code: "UPSTREAM_ERROR", detail: "malformed explorer payload" });

    healthData = { status: "healthy", network: "mainnet", indexer: [] };
    cache.clear();
    const badHealthTool = await client.callTool({ name: "get_registry_health", arguments: {} });
    expect(badHealthTool.isError).toBe(true);
    expect(JSON.parse(badHealthTool.content[0]?.type === "text" ? badHealthTool.content[0].text : "{}"))
      .toMatchObject({ code: "UPSTREAM_ERROR", detail: "malformed explorer payload" });
  });
});
