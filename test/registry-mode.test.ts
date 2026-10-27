/**
 * registry-mode.test.ts — discovery straight from the Identity contract
 * (REGISTRY_AGENT_IDS), with no explorer.
 *
 * The contract reader and the registration-file fetch are fakes; nothing here
 * touches the network. Registrations are built with the same SDK helpers
 * provider-kit's `registrationFile()` uses, so the pilot's on-chain shape is
 * what gets decoded.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StrKey } from "@stellar/stellar-sdk";
import { buildMetadataJson, NotFoundError, toDataUri } from "@trionlabs/stellar8004";
import { parseFlags, runCli } from "../src/cli/index.js";
import { loadConfig, type Config } from "../src/config.js";
import { classifyError, IndexerRequiredError, RegistryReadError } from "../src/lib/errors.js";
import { ExplorerService } from "../src/lib/explorer.js";
import { RegistryService } from "../src/lib/registry-source.js";
import { ReputationVerifier } from "../src/lib/reputation.js";
import type { IdentityReadClient } from "../src/lib/soroban.js";
import { buildServer } from "../src/server.js";
import { buildAgentProfile, type ToolDeps } from "../src/tools/shared.js";

const OWNER = "GDDTQFQZK734EXIJE5LWU4G4YC5A6P5AHJ4UWVMV6WBFWT6BAAQQHV2V";
const WALLET = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7));
const MANIFEST_URL = "https://provider.example/.well-known/stellar-agent-services.json";
const HOSTED_URL = "https://registrations.example/scrapper.json";

/** Agent 7: what `provider-kit register` writes for a pilot provider. */
const PILOT_REGISTRATION = buildMetadataJson({
  name: "Pilot Provider",
  description: "Paid inference behind x402",
  imageUrl: "",
  services: [
    { name: "stellar-agent-services", endpoint: MANIFEST_URL, version: "1" },
    { name: "web", endpoint: "https://provider.example" },
  ],
  supportedTrust: [],
  x402Enabled: true,
});

/** Agent 8: a hosted registration. */
const HOSTED_REGISTRATION = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Scrapper",
  description: "Scrapes the web",
  services: [{ name: "scrape", endpoint: "https://scrapper.example/run" }],
  supportedTrust: ["reputation"],
};

interface FakeAgent {
  uri: string;
  owner: string;
  wallet?: string;
}

const AGENTS: Record<number, FakeAgent> = {
  7: { uri: toDataUri(PILOT_REGISTRATION), owner: OWNER, wallet: WALLET },
  8: { uri: HOSTED_URL, owner: OWNER },
  9: { uri: "", owner: OWNER },
  // 10 is allowlisted but not registered.
};

function fakeIdentity(
  agents: Record<number, FakeAgent> = AGENTS,
  reads: number[] = [],
): IdentityReadClient {
  return {
    agent_uri: async ({ agent_id }) => {
      reads.push(agent_id);
      const agent = agents[agent_id];
      return {
        result: {
          isOk: () => agent !== undefined,
          unwrap: () => {
            if (!agent) throw new Error("Err(AgentNotFound)");
            return agent.uri;
          },
        },
      };
    },
    get_agent_wallet: async ({ agent_id }) => ({ result: agents[agent_id]?.wallet }),
    find_owner: async ({ agent_id }) => ({ result: agents[agent_id]?.owner }),
  };
}

function hostedFetch(body: unknown = HOSTED_REGISTRATION) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(HOSTED_URL);
    expect(init?.redirect).toBe("error");
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  });
}

function registryConfig(ids = "7,8,9,10"): Config {
  return loadConfig({ STELLAR_NETWORK: "testnet", REGISTRY_AGENT_IDS: ids, VERIFY_ONCHAIN: "false" });
}

function registry(
  opts: { agents?: Record<number, FakeAgent>; reads?: number[]; fetch?: typeof fetch; ids?: string } = {},
): RegistryService {
  return new RegistryService(registryConfig(opts.ids), {
    client: fakeIdentity(opts.agents, opts.reads),
    fetch: opts.fetch ?? (hostedFetch() as unknown as typeof fetch),
  });
}

describe("RegistryService reads the Identity contract and decodes the registration", () => {
  it("turns a provider-kit data: registration into the explorer's row shape", async () => {
    const { data } = await registry().getAgent(7);
    expect(data).toMatchObject({
      id: 7,
      owner: OWNER,
      wallet: WALLET,
      agentUri: AGENTS[7]!.uri,
      name: "Pilot Provider",
      description: "Paid inference behind x402",
      x402Enabled: true,
      mppEnabled: false,
      hasServices: true,
      supportedTrust: [],
      resolveStatus: "ready",
    });
    expect(data.services).toEqual([
      { name: "stellar-agent-services", endpoint: MANIFEST_URL, version: "1" },
      { name: "web", endpoint: "https://provider.example" },
    ]);
    // Nothing indexed is invented.
    expect(data.scores).toBeUndefined();
    expect(data.feedbackCount).toBeUndefined();
    expect(data.createdAt).toBeUndefined();
  });

  it("reads services from an older registration's endpoints list, as the SDK's edit path does", async () => {
    const legacy = {
      name: "Legacy",
      endpoints: [
        { type: "a2a", url: "https://legacy.example/a2a", version: "0.3" },
        { name: "mcp", endpoint: "https://legacy.example/mcp" },
        { url: "https://legacy.example/bare" },
        { type: "broken" },
        "not an entry",
      ],
    };
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify(legacy))}`;
    const { data } = await registry({ agents: { 7: { uri, owner: OWNER } }, ids: "7" }).getAgent(7);
    expect(data.services).toEqual([
      { name: "a2a", endpoint: "https://legacy.example/a2a", version: "0.3" },
      { name: "mcp", endpoint: "https://legacy.example/mcp" },
      { name: "unknown", endpoint: "https://legacy.example/bare" },
    ]);
    expect(data.hasServices).toBe(true);

    // `services` wins when both are present.
    const both = { ...legacy, services: [{ name: "web", endpoint: "https://legacy.example" }] };
    const bothUri = `data:application/json,${encodeURIComponent(JSON.stringify(both))}`;
    const read = await registry({ agents: { 7: { uri: bothUri, owner: OWNER } }, ids: "7" }).getAgent(7);
    expect(read.data.services).toEqual([{ name: "web", endpoint: "https://legacy.example" }]);
  });

  it("reads a percent-encoded data: URI", async () => {
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Plain" }))}`;
    const service = registry({ agents: { 7: { uri, owner: OWNER } } });
    expect((await service.getAgent(7)).data.name).toBe("Plain");
  });

  it("fetches an https: registration without following redirects", async () => {
    const fetch = hostedFetch();
    const { data } = await registry({ fetch: fetch as unknown as typeof globalThis.fetch }).getAgent(8);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(data).toMatchObject({ name: "Scrapper", supportedTrust: ["reputation"], wallet: null });
  });

  it("reads an agent with no URI as no-uri, without a fetch", async () => {
    const fetch = vi.fn();
    const { data } = await registry({ fetch: fetch as unknown as typeof globalThis.fetch }).getAgent(9);
    expect(fetch).not.toHaveBeenCalled();
    expect(data).toMatchObject({ id: 9, agentUri: null, resolveStatus: "no-uri", services: [] });
  });

  it("does not read ids outside the allowlist", async () => {
    const reads: number[] = [];
    await expect(registry({ reads }).getAgent(8)).resolves.toBeDefined();
    await expect(registry({ reads }).getAgent(99)).rejects.toBeInstanceOf(NotFoundError);
    expect(reads).not.toContain(99);
  });

  it("reports an allowlisted id that is not registered as not found", async () => {
    await expect(registry().getAgent(10)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("fails closed when a registration cannot be read, instead of returning empty fields", async () => {
    const cases: Array<[FakeAgent, typeof fetch | undefined, RegExp]> = [
      [{ uri: "ipfs://bafy/agent.json", owner: OWNER }, undefined, /only data: and https:/],
      [{ uri: HOSTED_URL, owner: OWNER }, (async () => new Response("", { status: 404 })) as typeof fetch, /HTTP 404/],
      [{ uri: HOSTED_URL, owner: OWNER }, hostedFetch("not json") as unknown as typeof fetch, /not JSON/],
      [{ uri: HOSTED_URL, owner: OWNER }, hostedFetch("[1,2]") as unknown as typeof fetch, /not a JSON object/],
      [
        { uri: HOSTED_URL, owner: OWNER },
        hostedFetch(JSON.stringify({ name: "x".repeat(70_000) })) as unknown as typeof fetch,
        /too large/,
      ],
      [{ uri: "data:text/plain,hello", owner: OWNER }, undefined, /not application\/json/],
    ];
    for (const [agent, fetch, message] of cases) {
      const error = await registry({ agents: { 7: agent }, ...(fetch ? { fetch } : {}) })
        .getAgent(7)
        .catch((e: unknown) => e);
      expect(error, String(message)).toBeInstanceOf(RegistryReadError);
      expect((error as Error).message).toMatch(message);
      expect(classifyError(error).code).toBe("UPSTREAM_ERROR");
    }
  });

  it("maps an RPC failure to an upstream error, not an internal one", async () => {
    const failing = {
      ...fakeIdentity(),
      find_owner: async () => {
        throw new Error("socket hang up");
      },
    } satisfies IdentityReadClient;
    const service = new RegistryService(registryConfig(), { client: failing });
    const error = await service.getAgent(7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegistryReadError);
    expect(classifyError(error)).toMatchObject({ code: "UPSTREAM_ERROR", detail: "registry read failed" });
  });
});

describe("RegistryService searches the allowlist locally and says what it skipped", () => {
  it("matches text and filters locally, with allowlist-only coverage", async () => {
    const service = registry();

    const scraper = await service.findAgentsWithCoverage("scraper");
    expect(scraper.agents.map((a) => a.id)).toEqual([8]);
    expect(scraper.coverage).toEqual({
      coverageComplete: false,
      paginationExhausted: true,
      snapshotConsistent: false,
      pagesScanned: 1,
      recordsScanned: 3,
      hasMore: false,
      limitations: [
        "registry-allowlist-only",
        "registry-reputation-not-indexed",
        "registry-agents-unreadable",
      ],
      unreadableAgentIds: [10],
    });

    const paid = await service.findAgentsWithCoverage("", { filters: { x402: true } });
    expect(paid.agents.map((a) => a.id)).toEqual([7]);
    const trusted = await service.findAgentsWithCoverage("", { filters: { trust: "reputation" } });
    expect(trusted.agents.map((a) => a.id)).toEqual([8]);
    const withServices = await service.findAgentsWithCoverage("", { filters: { hasServices: true } });
    expect(withServices.agents.map((a) => a.id)).toEqual([7, 8]);
  });

  it("refuses a score filter instead of ignoring it", async () => {
    await expect(
      registry().findAgentsWithCoverage("", { filters: { minScore: 70 } }),
    ).rejects.toBeInstanceOf(IndexerRequiredError);
    await expect(registry().listAgents({ page: 1, limit: 5, minScore: 1 })).rejects.toBeInstanceOf(
      IndexerRequiredError,
    );
  });

  it("throws when an outage leaves nothing readable, so it never looks like an empty registry", async () => {
    const down = {
      agent_uri: async () => {
        throw new Error("503");
      },
      get_agent_wallet: async () => ({ result: undefined }),
      find_owner: async () => ({ result: undefined }),
    } satisfies IdentityReadClient;
    const service = new RegistryService(registryConfig(), { client: down });
    await expect(service.findAgentsWithCoverage("")).rejects.toBeInstanceOf(RegistryReadError);
  });

  it("pages the allowlist in id order with exact totals", async () => {
    const service = registry();
    const first = await service.listAgents({ page: 1, limit: 2 });
    expect(first.agents.map((a) => a.id)).toEqual([7, 8]);
    expect(first.pagination).toEqual({ page: 1, limit: 2, total: 3, hasMore: true });
    const second = await service.listAgents({ page: 2, limit: 2 });
    expect(second.agents.map((a) => a.id)).toEqual([9]);
    expect(second.pagination).toEqual({ page: 2, limit: 2, total: 3, hasMore: false });
    expect(second.coverage).toMatchObject({ paginationExhausted: true, unreadableAgentIds: [10] });
  });
});

describe("a registry row is an explorer row", () => {
  it("passes the explorer's own row validation and builds the same AgentProfile", async () => {
    const config = registryConfig();
    const source = registry();
    const row = (await source.getAgent(7)).data;
    const explorer = new ExplorerService(
      { ...config, explorerBaseUrl: "https://indexer.example", registryAgentIds: null },
      {
        client: {
          getAgent: async () => ({
            success: true,
            data: row,
            meta: { version: "1", chain: "stellar", network: "testnet", timestamp: "", requestId: "" },
          }),
        } as never,
      },
    );
    const verifier = new ReputationVerifier(config);
    const viaRegistry = await buildAgentProfile({ config, source, verifier }, 7, { verify: false });
    const viaExplorer = await buildAgentProfile({ config, source: explorer, verifier }, 7, { verify: false });

    const withoutTimestamp = (p: typeof viaRegistry.profile) => ({
      ...p,
      verification: { ...p.verification, checkedAt: "" },
    });
    expect(withoutTimestamp(viaRegistry.profile)).toEqual(withoutTimestamp(viaExplorer.profile));
    expect(viaRegistry.profile).toMatchObject({
      network: "testnet",
      owner: OWNER,
      wallet: WALLET,
      capabilities: { x402: true, hasServices: true },
    });
    expect(viaRegistry.profile.stellarId).toMatch(/^stellar:testnet:C[A-Z2-7]{55}#7$/);
  });
});

// ---------------------------------------------------------------------------
// The MCP surface in registry mode
// ---------------------------------------------------------------------------

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

async function connect(): Promise<Client> {
  const config = registryConfig();
  const deps: ToolDeps = { config, source: registry(), verifier: new ReputationVerifier(config) };
  const server = buildServer(config, { version: "test", deps });
  const client = new Client({ name: "registry-mode-test", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(() => client.close(), () => server.close());
  return client;
}

type CallResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: any };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args })) as CallResult;
}

const textOf = (result: CallResult) => result.content.map((c) => c.text ?? "").join("\n");

const SOURCE_NOTE = {
  kind: "registry",
  allowlistSize: 4,
  reputationIndexed: false,
};

describe("tools in registry mode", () => {
  it("list_services shows the registered manifest URL as an unverified listing", async () => {
    const client = await connect();
    const result = await call(client, "list_services", { x402: true });
    expect(result.isError).toBeFalsy();
    const services = result.structuredContent.services;
    const manifest = services.find(
      (row: any) => row.service.value.name === "stellar-agent-services",
    );
    expect(manifest).toMatchObject({
      agentId: 7,
      capabilities: { x402: true },
      endpointVerified: false,
      livenessVerified: false,
      paymentVerified: false,
      service: { provenance: "self-declared", verified: false, value: { endpoint: MANIFEST_URL } },
    });
    expect(result.structuredContent.source).toMatchObject(SOURCE_NOTE);
    expect(result.structuredContent.coverage.limitations).toContain("registry-allowlist-only");
    expect(textOf(result)).toContain("Registry mode");
  });

  it("find_agent, list_agents and rank_agent work over the allowlist and say reputation is not measured", async () => {
    const client = await connect();

    const found = await call(client, "find_agent", { query: "a scraper" });
    expect(found.isError).toBeFalsy();
    expect(found.structuredContent.agents.map((a: any) => a.id)).toEqual([8]);
    expect(found.structuredContent.source).toMatchObject(SOURCE_NOTE);
    expect(textOf(found)).toMatch(/reputation is not indexed, so scores and feedback counts are not measured/);

    const listed = await call(client, "list_agents", { limit: 2 });
    expect(listed.isError).toBeFalsy();
    expect(listed.structuredContent.pagination).toEqual({ page: 1, limit: 2, total: 3, hasMore: true });
    expect(listed.structuredContent.coverage.unreadableAgentIds).toEqual([10]);

    const ranked = await call(client, "rank_agent", { agentIds: [7, 99], verify: false });
    expect(ranked.isError).toBeFalsy();
    expect(ranked.structuredContent.agents.map((a: any) => a.id)).toEqual([7]);
    expect(ranked.structuredContent.source).toMatchObject(SOURCE_NOTE);
  });

  it("tells the client up front that it is in registry mode", async () => {
    const client = await connect();
    expect(client.getInstructions()).toMatch(/REGISTRY MODE: this server has no explorer/);
  });

  it("searches without a score implied by a word like 'best' or 'trusted', and says so", async () => {
    const client = await connect();
    for (const query of ["best scraper", "a trusted scraper", "a scraper with a good reputation"]) {
      const result = await call(client, "find_agent", { query });
      expect(result.isError, query).toBeFalsy();
      expect(result.structuredContent.agents.map((a: any) => a.id)).toEqual([8]);
      expect(result.structuredContent.interpretedQuery.filters.minExplorerScore).toBeUndefined();
      expect(result.structuredContent.coverage.limitations).toContain("implied-score-filter-not-applied");
      expect(textOf(result)).toMatch(/implies a minimum score, which registry mode cannot apply/);
    }

    const ranked = await call(client, "rank_agent", { query: "best scraper", verify: false });
    expect(ranked.isError).toBeFalsy();
    expect(ranked.structuredContent.agents.map((a: any) => a.id)).toEqual([8]);
    expect(ranked.structuredContent.coverage.limitations).toContain("implied-score-filter-not-applied");
    expect(textOf(ranked)).toMatch(/implies a minimum score/);

    // A query with no quality word carries no such note.
    const plain = await call(client, "find_agent", { query: "a scraper" });
    expect(plain.structuredContent.coverage.limitations).not.toContain("implied-score-filter-not-applied");
    expect(textOf(plain)).not.toMatch(/implies a minimum score/);
  });

  it("still refuses a score threshold the caller stated", async () => {
    const client = await connect();
    for (const args of [
      { query: "a scraper", minExplorerScore: 70 },
      { query: "best scraper", minExplorerScore: 70 },
      { query: "a scraper with score above 70" },
    ]) {
      const result = await call(client, "find_agent", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(JSON.parse(textOf(result))).toMatchObject({ code: "INDEXER_REQUIRED" });
    }
    const ranked = await call(client, "rank_agent", { query: "scrapers rated 80", verify: false });
    expect(JSON.parse(textOf(ranked))).toMatchObject({ code: "INDEXER_REQUIRED" });
  });

  it("get_agent_profile does not print unmeasured counts and marks feedback as needing an indexer", async () => {
    const client = await connect();
    const result = await call(client, "get_agent_profile", { agent: 7, verify: false });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).not.toMatch(/feedback\(s\)|unique client/);
    expect(text).toContain("Registry mode");
    expect(result.structuredContent.feedbackCoverage).toMatchObject({
      windowComplete: false,
      pagesScanned: 0,
      limitations: ["feedback-requires-indexer"],
    });
    expect(result.structuredContent.profile).toMatchObject({ id: 7, wallet: WALLET, resolveStatus: "ready" });
    expect(result.structuredContent.source).toMatchObject(SOURCE_NOTE);
  });

  it("get_agent_card and verify_reputation answer for an allowlisted agent", async () => {
    const client = await connect();
    const card = await call(client, "get_agent_card", { agent: 7 });
    expect(card.isError).toBeFalsy();
    expect(card.structuredContent.source).toMatchObject(SOURCE_NOTE);

    const verified = await call(client, "verify_reputation", { agent: 7 });
    expect(verified.isError).toBeFalsy();
    expect(textOf(verified)).toContain("no Explorer-declared reputation (not indexed)");
    expect(textOf(verified)).not.toMatch(/feedbacks 0/);
    expect(verified.structuredContent.source).toMatchObject(SOURCE_NOTE);
  });

  it.each([
    ["leaderboard", {}],
    ["get_registry_stats", {}],
    ["get_registry_health", {}],
    ["get_agents_by_owner", { owner: OWNER }],
    ["get_agent_feedback", { agent: 7 }],
    ["resolve_agent", { ref: OWNER }],
  ])("%s says it needs an indexer instead of answering from the allowlist", async (name, args) => {
    const client = await connect();
    const result = await call(client, name, args);
    expect(result.isError).toBe(true);
    const body = JSON.parse(textOf(result));
    expect(body).toMatchObject({ code: "INDEXER_REQUIRED", detail: "registry mode" });
    expect(body.error).toMatch(/needs an indexer.*REGISTRY_AGENT_IDS.*EXPLORER_BASE_URL/);
  });

  it("resolve_agent still resolves ids and handles, which need no I/O", async () => {
    const client = await connect();
    const result = await call(client, "resolve_agent", { ref: 7 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.agents[0].id).toBe(7);
  });

  it("serves agent resources and refuses indexer-backed ones", async () => {
    const client = await connect();
    const profile = await client.readResource({ uri: "stellar8004://agent/7" });
    const json = JSON.parse((profile.contents[0] as { text: string }).text);
    expect(json).toMatchObject({ id: 7, source: SOURCE_NOTE });
    expect((profile.contents[1] as { text: string }).text).toContain("Registry mode");

    await expect(client.readResource({ uri: "stellar8004://registry" })).rejects.toThrow(/needs an indexer/);
    await expect(client.readResource({ uri: "stellar8004://agent/7/feedback" })).rejects.toThrow(
      /needs an indexer/,
    );

    const listed = await client.listResources();
    const agentResources = listed.resources.filter((r) => r.uri.startsWith("stellar8004://agent/"));
    expect(agentResources.map((r) => r.uri)).toEqual([
      "stellar8004://agent/7",
      "stellar8004://agent/8",
      "stellar8004://agent/9",
    ]);
    expect(agentResources.every((r) => !/score|feedback/.test(`${r.title} ${r.description}`))).toBe(true);
  });
});

/** Keep the fixture honest: agent 7's registration is what provider-kit writes. */
describe.sequential("CLI in registry mode", () => {
  function captureStdout(): () => string {
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    return () => stdout;
  }

  function cliDeps(): ToolDeps {
    const config = registryConfig();
    return { config, source: registry(), verifier: new ReputationVerifier(config) };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("find drops a score implied by 'best' and says so", async () => {
    const stdout = captureStdout();
    const code = await runCli(parseFlags(["find", "best", "scraper"]), "test", cliDeps());
    expect(code).toBe(0);
    expect(stdout()).toMatch(/1 agent\(s\) for "best scraper"/);
    expect(stdout()).toMatch(/implies a minimum score, which registry mode cannot apply/);
  });

  it("find still refuses an explicit --min-explorer-score", async () => {
    captureStdout();
    const code = await runCli(
      parseFlags(["find", "scraper", "--min-explorer-score", "70"]),
      "test",
      cliDeps(),
    );
    expect(code).not.toBe(0);
  });

  it("doctor does not list leaderboard as available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "healthy" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const stdout = captureStdout();
    await runCli(parseFlags(["doctor", "--json"]), "test", cliDeps());
    const tools = JSON.parse(stdout()).checks.find((check: { name: string }) => check.name === "tools");
    expect(tools.detail).toMatch(/leaderboard, registry stats, owner lookups and feedback history need an indexer/);
    expect(tools.detail).not.toMatch(/\+ list_agents, leaderboard/);
  });
});

describe("fixture", () => {
  it("is the ERC-8004 registration-v1 shape with the manifest service entry", () => {
    expect(PILOT_REGISTRATION).toMatchObject({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      x402: true,
      services: [{ name: "stellar-agent-services", endpoint: MANIFEST_URL, version: "1" }, { name: "web" }],
    });
    expect(AGENTS[7]!.uri.startsWith("data:application/json;base64,")).toBe(true);
  });
});
