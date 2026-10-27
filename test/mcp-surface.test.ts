/**
 * mcp-surface.test.ts — pin what a client sees before it calls anything: the server
 * instructions (explorer and registry mode), every tool's input and output schema, the
 * prompts, the resource templates and the static resources.
 *
 * The snapshot is test/__surface__/mcp-surface.json. Any change to the surface fails here
 * until the snapshot is regenerated (`npx vitest run test/mcp-surface.test.ts -u`), so the
 * PR diff shows exactly what a client will see differently. The `MCP surface` workflow then
 * compares the committed snapshot with the base branch's and fails on a change that would
 * break an existing client (scripts/ci/surface-compat.mjs).
 *
 * Offline: both data sources are stubs that throw. Listing tools, prompts and templates reads
 * no data, and the agent-resource listing swallows the error and lists none, which leaves
 * exactly the static resources.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadConfig, type Config } from "../src/config.js";
import { ExplorerService } from "../src/lib/explorer.js";
import { RegistryService } from "../src/lib/registry-source.js";
import { ReputationVerifier } from "../src/lib/reputation.js";
import { buildServer } from "../src/server.js";
import type { ToolDeps } from "../src/tools/shared.js";

const SNAPSHOT = "./__surface__/mcp-surface.json";

/** Every method on this object throws, so a stray read fails loudly instead of reaching the network. */
const offline = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("mcp-surface.test: the surface must be listable without reading data");
    },
  },
) as never;

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

async function surfaceOf(config: Config) {
  const source =
    config.registryAgentIds === null
      ? new ExplorerService(config, { client: offline })
      : new RegistryService(config, { client: offline, fetch: offline });
  const deps: ToolDeps = { config, source, verifier: new ReputationVerifier(config) };
  const server = buildServer(config, { version: "surface", deps });
  const client = new Client({ name: "mcp-surface-test", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(() => client.close(), () => server.close());

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    instructions: client.getInstructions() ?? "",
    tools: (await client.listTools()).tools.sort(byName),
    prompts: (await client.listPrompts()).prompts.sort(byName),
    resourceTemplates: (await client.listResourceTemplates()).resourceTemplates.sort((a, b) =>
      a.uriTemplate.localeCompare(b.uriTemplate),
    ),
    resources: (await client.listResources()).resources.sort((a, b) => a.uri.localeCompare(b.uri)),
  };
}

describe("MCP surface", () => {
  it("matches the committed snapshot", async () => {
    const explorer = await surfaceOf(loadConfig({ STELLAR_NETWORK: "mainnet", VERIFY_ONCHAIN: "false" }));
    const registry = await surfaceOf(
      loadConfig({ STELLAR_NETWORK: "testnet", REGISTRY_AGENT_IDS: "1,2", VERIFY_ONCHAIN: "false" }),
    );

    // Registry mode registers the same surface and changes only what the instructions say;
    // its indexer-only tools refuse at call time instead of disappearing from the list.
    const { instructions: explorerInstructions, ...explorerRest } = explorer;
    const { instructions: registryInstructions, ...registryRest } = registry;
    expect(registryRest).toEqual(explorerRest);
    expect(explorer.resources.every((r) => !r.uri.startsWith("stellar8004://agent/"))).toBe(true);

    const snapshot = {
      instructions: { explorer: explorerInstructions, registry: registryInstructions },
      ...explorerRest,
    };
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(SNAPSHOT);
  });
});
