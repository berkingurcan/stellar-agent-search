/** End-to-end in-memory contract for the split MCP v2 client/server packages. */

import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { AgentResponse, ApiResponse } from "@trionlabs/stellar8004";
import { loadConfig } from "../src/config.js";
import { ExplorerService, type GetAgentsParams } from "../src/lib/explorer.js";
import { ReputationVerifier } from "../src/lib/reputation.js";
import { buildServer } from "../src/server.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

describe("MCP v2 server contract", () => {
  it("lists tools/resources/prompts and invokes an injected dependency through z.object schemas", async () => {
    const config = loadConfig({
      STELLAR_NETWORK: "mainnet",
      VERIFY_ONCHAIN: "false",
    } as NodeJS.ProcessEnv);
    const calls: GetAgentsParams[] = [];
    const row = {
      id: 42,
      name: "MPP Agent",
      description: "test",
      owner: "GOWNER42",
      x402Enabled: false,
      mppEnabled: true,
      hasServices: false,
      feedbackCount: 2,
      avgScore: 80,
      uniqueClients: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    } as AgentResponse;
    const response: ApiResponse<AgentResponse[]> = {
      success: true,
      data: [row],
      meta: {
        version: "1",
        chain: "stellar",
        network: "mainnet",
        timestamp: "now",
        requestId: "mcp-v2-test",
        pagination: { page: 1, limit: 20, total: 1, hasMore: false },
      },
    };
    const explorer = new ExplorerService(config, {
      client: {
        getAgents: async (params: GetAgentsParams = {}) => {
          calls.push(params);
          return response;
        },
      } as never,
    });
    const server = buildServer(config, {
      version: "test",
      deps: { config, explorer, verifier: new ReputationVerifier(config) },
    });
    const client = new Client(
      { name: "mcp-v2-test", version: "test" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closers.push(() => client.close(), () => server.close());

    expect((await client.listTools()).tools.length).toBeGreaterThanOrEqual(12);
    expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(5);
    expect((await client.listPrompts()).prompts).toHaveLength(5);

    const result = await client.callTool({
      name: "list_agents",
      arguments: { mpp: true },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ page: 1, limit: 20, mpp: true }]);
    expect(result.structuredContent).toMatchObject({ count: 1, page: 1 });
  });
});
