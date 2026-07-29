import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ApiResponse, HealthResponse } from "@trionlabs/stellar8004";
import { loadConfig } from "../src/config.js";
import {
  ExplorerService,
  type ExplorerStatsResponse,
} from "../src/lib/explorer.js";
import { buildRegistryStatsView } from "../src/lib/registry-stats.js";
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
  it("validates the newer optional MPP count and never labels sampled distributions global", () => {
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

    const invalidMpp = buildRegistryStatsView({ ...stats, agentsWithMpp: -1 }, "mainnet");
    expect(invalidMpp.agentsWithMpp).toBeNull();
    expect(invalidMpp.coverage.exactCountMetrics).not.toContain("agentsWithMpp");

    const { agentsWithMpp: _omitted, ...withoutMpp } = stats;
    const missingMpp = buildRegistryStatsView(withoutMpp, "mainnet");
    expect(missingMpp.agentsWithMpp).toBeNull();
    expect(missingMpp.coverage.exactCountMetrics).not.toContain("agentsWithMpp");
  });

  it("exposes definitions and coverage through both the stats tool and registry resource", async () => {
    const config = loadConfig({
      STELLAR_NETWORK: "mainnet",
      VERIFY_ONCHAIN: "false",
    } as NodeJS.ProcessEnv);
    const statsResponse: ApiResponse<ExplorerStatsResponse> = {
      success: true,
      data: stats,
      meta,
    };
    const healthResponse: ApiResponse<HealthResponse> = {
      success: true,
      data: {
        status: "ok",
        network: "mainnet",
        indexer: {
          identity: { lastLedger: 1, stale: false },
          reputation: { lastLedger: 1, stale: false },
          validation: { lastLedger: 1, stale: false },
        },
      },
      meta,
    };
    const explorer = new ExplorerService(config, {
      client: {
        getStats: async () => statsResponse,
        health: async () => healthResponse,
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

    const resource = await client.readResource({ uri: "stellar8004://registry" });
    const jsonContent = resource.contents.find(
      (entry) => entry.mimeType === "application/json" && "text" in entry,
    );
    expect(jsonContent).toBeDefined();
    const parsed = JSON.parse((jsonContent as { text: string }).text) as {
      stats: ReturnType<typeof buildRegistryStatsView>;
    };
    expect(parsed.stats.agentsWithMpp).toBe(12);
    expect(parsed.stats.coverage.distributionsGlobalExact).toBe(false);
    expect(parsed.stats.metricDefinitions.protocolDistribution).toContain("service-entry counts");
  });
});
