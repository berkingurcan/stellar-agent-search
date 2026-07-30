import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { EXPECTED_SERVER_VERSION, runCanary } from "../scripts/canary.mjs";

const VERSION_ID = "12345678-1234-1234-1234-123456789abc";
const ORIGIN = "https://mcp.stellar8004.com";

function jsonResponse(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function validInitializeResult() {
  return {
    protocolVersion: "2025-11-25",
    serverInfo: { name: "stellar-agent-market", version: EXPECTED_SERVER_VERSION },
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false },
      prompts: { listChanged: false },
    },
  };
}

function freshHealth() {
  return {
    status: "healthy",
    network: "mainnet",
    anyStale: false,
    indexer: {
      identity: { lastLedger: 1, stale: false },
      reputation: { lastLedger: 1, stale: false },
      validation: { lastLedger: 1, stale: false },
    },
  };
}

function mockFetch(toolResult, initializeResult = validInitializeResult()) {
  const requests = [];
  const fetchMock = vi.fn(async (input, init = {}) => {
    const request = new Request(input, init);
    requests.push(request);
    if (requests.length === 1) {
      return jsonResponse({ status: "ok" }, { "x-worker-version": VERSION_ID });
    }
    const requestBody = await request.clone().json();
    if (requests.length === 2) {
      return jsonResponse(
        { jsonrpc: "2.0", id: requestBody.id, result: initializeResult },
        { "mcp-session-id": "canary-session" },
      );
    }
    return jsonResponse({ jsonrpc: "2.0", id: requestBody.id, result: toolResult });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deployment canary", () => {
  it("derives the expected MCP server version from the release package", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(EXPECTED_SERVER_VERSION).toBe(pkg.version);
  });

  it.each([
    { isError: true, content: [{ type: "text", text: "Explorer unavailable" }] },
    { error: { code: "UPSTREAM_ERROR", message: "Explorer unavailable" } },
  ])("rejects a tool-level error result", async (toolResult) => {
    mockFetch(toolResult);
    await expect(
      runCanary({ origin: ORIGIN, versionId: VERSION_ID, label: "error-proof" }),
    ).rejects.toThrow("tool-level error");
  });

  it("requires typed mainnet health and marks every MCP probe no-cache", async () => {
    const { requests } = mockFetch({
      isError: false,
      structuredContent: freshHealth(),
    });

    const result = await runCanary({ origin: ORIGIN, versionId: VERSION_ID, label: "fresh-proof" });

    expect(result.checks.explorerServiceBindingPath).toBe(true);
    expect(result.checks.mcpIdentityAndCapabilities).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests[1].headers.get("cache-control")).toBe("no-cache");
    expect(requests[2].headers.get("cache-control")).toBe("no-cache");
  });

  it("rejects a success-shaped result without valid structured health", async () => {
    mockFetch({ isError: false, structuredContent: { ...freshHealth(), network: "testnet" } });
    await expect(
      runCanary({ origin: ORIGIN, versionId: VERSION_ID, label: "wrong-network" }),
    ).rejects.toThrow("invalid or stale structured health data");
  });

  it.each([
    ["wrong protocol", { ...validInitializeResult(), protocolVersion: "2024-11-05" }, /protocolVersion/],
    [
      "wrong server name",
      { ...validInitializeResult(), serverInfo: { name: "lookalike", version: EXPECTED_SERVER_VERSION } },
      /serverInfo\.name/,
    ],
    [
      "binding-controlled version",
      { ...validInitializeResult(), serverInfo: { name: "stellar-agent-market", version: "999.0.0" } },
      /serverInfo\.version/,
    ],
    [
      "missing tools capability",
      {
        ...validInitializeResult(),
        capabilities: {
          resources: { listChanged: false },
          prompts: { listChanged: false },
        },
      },
      /tools\.listChanged/,
    ],
    [
      "mutable resource surface",
      {
        ...validInitializeResult(),
        capabilities: {
          ...validInitializeResult().capabilities,
          resources: { listChanged: true },
        },
      },
      /resources\.listChanged/,
    ],
  ])("rejects initialize drift: %s", async (_label, initializeResult, expected) => {
    mockFetch({ isError: false, structuredContent: freshHealth() }, initializeResult);
    await expect(
      runCanary({ origin: ORIGIN, versionId: VERSION_ID, label: "identity-drift" }),
    ).rejects.toThrow(expected);
  });

  it.each(["identity", "reputation", "validation"])(
    "rejects stale %s indexer health",
    async (name) => {
      const health = freshHealth();
      health.indexer[name].stale = true;
      health.anyStale = true;
      mockFetch({ isError: false, structuredContent: health });
      await expect(
        runCanary({ origin: ORIGIN, versionId: VERSION_ID, label: "stale-indexer" }),
      ).rejects.toThrow("invalid or stale structured health data");
    },
  );
});
