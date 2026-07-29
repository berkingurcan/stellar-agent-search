import { describe, expect, it } from "vitest";
import type { AgentResponse, FeedbackResponse } from "@trionlabs/stellar8004";
import { loadConfig } from "../src/config.js";
import {
  buildFeedbackJson,
  feedbackValueOrNull,
  parseIdVar,
  renderFeedbackMarkdown,
} from "../src/resources/index.js";
import { registerListAgents } from "../src/tools/list_agents.js";
import { registerListServices } from "../src/tools/list_services.js";
import type { ToolDeps } from "../src/tools/shared.js";

const OWNER = "GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V";

function agent(id = 1): AgentResponse {
  return {
    id,
    owner: OWNER,
    name: `Agent ${id}`,
    description: "declared description",
    x402Enabled: true,
    hasServices: true,
    avgScore: 90,
    feedbackCount: 2,
    uniqueClients: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as AgentResponse;
}

function capture(
  register: (server: any, deps: ToolDeps) => void,
  name: string,
  deps: ToolDeps,
) {
  let definition: any;
  let handler: ((args: any) => Promise<any>) | undefined;
  register(
    {
      registerTool(toolName: string, toolDefinition: unknown, toolHandler: typeof handler) {
        if (toolName === name) {
          definition = toolDefinition;
          handler = toolHandler;
        }
      },
    },
    deps,
  );
  if (!handler) throw new Error(`${name} was not registered`);
  return { definition, handler };
}

function baseDeps(explorer: unknown): ToolDeps {
  return {
    config: loadConfig({ STELLAR_NETWORK: "mainnet", VERIFY_ONCHAIN: "false" }),
    explorer,
    verifier: { verifyAgainst: async () => ({ status: "skipped" }) },
  } as unknown as ToolDeps;
}

describe("feedback resource precision and coverage", () => {
  const coverage = {
    coverageComplete: false,
    paginationExhausted: false,
    snapshotConsistent: false,
    pagesScanned: 1,
    recordsScanned: 1,
    hasMore: true,
  };
  const item = {
    feedbackIndex: 7,
    clientAddress: OWNER,
    value: "100000000000000000001",
    valueDecimals: 0,
    isRevoked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    responses: [],
  } as FeedbackResponse;

  it("preserves signed i128 decimal strings instead of coercing through Number", () => {
    expect(feedbackValueOrNull(item.value)).toBe("100000000000000000001");
    expect(feedbackValueOrNull("-100000000000000000001")).toBe(
      "-100000000000000000001",
    );
    expect(feedbackValueOrNull(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(feedbackValueOrNull("170141183460469231731687303715884105728")).toBeNull();

    const json = buildFeedbackJson(1, [item], coverage, {
      page: 1,
      limit: 20,
      total: 21,
      hasMore: true,
    });
    expect(json.feedback[0].value).toBe("100000000000000000001");
    expect(json.coverage).toMatchObject({ coverageComplete: false, hasMore: true });
    expect(json.pagination).toEqual({ page: 1, limit: 20, total: 21, hasMore: true });

    const markdown = renderFeedbackMarkdown(1, [item], coverage);
    expect(markdown).toContain("value=100000000000000000001");
    expect(markdown).toContain("coverageComplete=false");
    expect(markdown).toContain("hasMore=true");
  });

  it("enforces the on-chain u32 agent-id boundary before any resource read", () => {
    expect(parseIdVar("4294967295")).toBe(4294967295);
    expect(() => parseIdVar("4294967296")).toThrow(/unsigned 32-bit/);
  });
});

describe("discovery output honesty", () => {
  it("list_agents exposes upstream pagination and incomplete single-page coverage", async () => {
    const explorer = {
      getAgents: async () => ({
        data: [agent(1)],
        meta: {
          chain: "stellar",
          network: "mainnet",
          pagination: { page: 1, limit: 20, total: 100, hasMore: true },
        },
      }),
    };
    const { handler } = capture(registerListAgents, "list_agents", baseDeps(explorer));
    const result = await handler({
      limit: 20,
      page: 1,
      sortBy: "score",
      verify: false,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 100,
      hasMore: true,
    });
    expect(result.structuredContent.coverage).toEqual({
      coverageComplete: false,
      paginationExhausted: false,
      snapshotConsistent: false,
      pagesScanned: 1,
      recordsScanned: 1,
      hasMore: true,
      limitations: ["v1-unversioned-offset-pagination"],
    });
  });

  it("never calls a final offset page globally complete when prior pages were not scanned", async () => {
    const explorer = {
      getAgents: async () => ({
        data: [agent(21)],
        meta: {
          chain: "stellar",
          network: "mainnet",
          pagination: { page: 2, limit: 20, total: 21, hasMore: false },
        },
      }),
    };
    const { handler } = capture(registerListAgents, "list_agents", baseDeps(explorer));
    const result = await handler({
      limit: 20,
      page: 2,
      sortBy: "score",
      verify: false,
    });

    expect(result.structuredContent.coverage).toEqual({
      coverageComplete: false,
      paginationExhausted: true,
      snapshotConsistent: false,
      pagesScanned: 1,
      recordsScanned: 1,
      hasMore: false,
      limitations: [
        "v1-unversioned-offset-pagination",
        "prior-pages-not-scanned",
      ],
    });
  });

  it("list_services labels candidates unverified and rejects snapshot-complete hydration claims", async () => {
    const listed = agent(3);
    const explorer = {
      findAgentsWithCoverage: async () => ({
        agents: [listed],
        coverage: {
          coverageComplete: true,
          paginationExhausted: true,
          snapshotConsistent: true,
          pagesScanned: 1,
          recordsScanned: 1,
          hasMore: false,
        },
      }),
      getAgent: async () => ({
        data: {
          ...listed,
          services: [{ name: "pay", endpoint: "https://declared.invalid/pay" }],
        },
      }),
    };
    const { definition, handler } = capture(
      registerListServices,
      "list_services",
      baseDeps(explorer),
    );
    const result = await handler({ search: "", limit: 20, page: 1 });

    expect(definition.description).not.toMatch(/callable|invokable/i);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.services[0]).toMatchObject({
      capabilitiesVerified: false,
      trustVerified: false,
      endpointVerified: false,
      livenessVerified: false,
      protocolConformanceVerified: false,
      paymentVerified: false,
    });
    expect(result.structuredContent.coverage).toMatchObject({
      coverageComplete: false,
      snapshotConsistent: false,
      detailsHydrated: 1,
      limitations: ["detail-hydration-unversioned"],
    });
  });
});
