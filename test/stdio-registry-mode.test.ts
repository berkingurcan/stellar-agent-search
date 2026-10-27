/**
 * stdio-registry-mode.test.ts — registry mode through the REAL built binary
 * (dist/index.js), launched the way an MCP client launches it.
 *
 * registry-mode.test.ts drives the same code in-process; this suite pins what only
 * the shipped artifact can show: the startup rules and their exit codes, the
 * registry-mode instructions over the wire, indexer-only tools refusing, a failed
 * allowlist read failing closed, and stdout staying JSON-RPC-only while registry
 * warnings go to stderr.
 *
 * Offline: STELLAR_RPC_URL points at a closed local port, so every Identity read
 * fails at once and nothing reaches the network.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist", "index.js");
const CLOSED_RPC = "http://127.0.0.1:9";

/** The caller's environment without any data-source setting it may carry. */
function cleanEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["STELLAR_NETWORK", "STELLAR_RPC_URL", "EXPLORER_BASE_URL", "REGISTRY_AGENT_IDS", "VERIFY_ONCHAIN"]) {
    delete env[name];
  }
  return { ...env, ...overrides };
}

type Message = { jsonrpc?: string; id?: number; result?: any; error?: any };

/** A stdio MCP session over raw newline-delimited JSON-RPC, so stdout framing is checked line by line. */
class Session {
  readonly child: ChildProcessWithoutNullStreams;
  stdout = "";
  stderr = "";
  private nextId = 1;
  private waiting = new Map<number, (message: Message) => void>();

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [BIN, "serve"], { stdio: ["pipe", "pipe", "pipe"], env });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    let pending = "";
    this.child.stdout.on("data", (chunk: string) => {
      this.stdout += chunk;
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const message = JSON.parse(line) as Message;
          if (typeof message.id === "number") this.waiting.get(message.id)?.(message);
        } catch {
          // Left for the framing assertion, which reports the offending line.
        }
      }
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Message> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method} (id ${id})\n${this.stderr}`)), 15_000);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  close(): void {
    if (!this.child.killed) this.child.kill("SIGTERM");
  }
}

const errorBody = (message: Message) => JSON.parse(message.result.content[0].text) as { code: string; error: string };

beforeAll(() => {
  if (!existsSync(BIN)) execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
}, 120_000);

describe("the built binary refuses an ambiguous data source at startup", () => {
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ["testnet with no data source", { STELLAR_NETWORK: "testnet" }, /requires an explicit EXPLORER_BASE_URL or REGISTRY_AGENT_IDS/],
    ["testnet with a blank allowlist", { STELLAR_NETWORK: "testnet", REGISTRY_AGENT_IDS: "  " }, /requires an explicit EXPLORER_BASE_URL or REGISTRY_AGENT_IDS/],
    [
      "an explorer and an allowlist at once",
      { STELLAR_NETWORK: "testnet", REGISTRY_AGENT_IDS: "1", EXPLORER_BASE_URL: "https://indexer.example" },
      /Set EXPLORER_BASE_URL or REGISTRY_AGENT_IDS, not both/,
    ],
    ["a malformed allowlist", { STELLAR_NETWORK: "testnet", REGISTRY_AGENT_IDS: "1,abc" }, /must be a comma-separated list of agent ids/],
    [
      "an allowlist over the cap",
      { STELLAR_NETWORK: "testnet", REGISTRY_AGENT_IDS: Array.from({ length: 51 }, (_, i) => i + 1).join(",") },
      /registry mode reads at most 50/,
    ],
  ];

  it.each(cases)("%s: exit 2 with a plain error line", (_label, env, message) => {
    const result = spawnSync(process.execPath, [BIN, "serve"], { env: cleanEnv(env), input: "", encoding: "utf8", timeout: 15_000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^error: /);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).not.toMatch(/fatal:|at .+\.js:\d+/);
    expect(result.stdout).toBe("");
  });
});

describe("the built binary serves registry mode over stdio", () => {
  let session: Session;
  let initialize: Message;

  beforeAll(async () => {
    session = new Session(
      cleanEnv({ STELLAR_NETWORK: "testnet", REGISTRY_AGENT_IDS: "1,2", STELLAR_RPC_URL: CLOSED_RPC, VERIFY_ONCHAIN: "false" }),
    );
    initialize = await session.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-registry-mode-test", version: "0" },
    });
    session.notify("notifications/initialized");
  }, 20_000);

  afterAll(() => session?.close());

  it("says it is in registry mode before any tool is called", () => {
    expect(initialize.result.serverInfo.name).toBe("stellar-agent-search");
    expect(initialize.result.instructions).toMatch(/REGISTRY MODE: this server has no explorer/);
    expect(session.stderr).toContain("MCP stdio server ready on testnet");
  });

  it("lists every tool, including the indexer-only ones", async () => {
    const list = await session.request("tools/list");
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["find_agent", "leaderboard", "get_registry_stats", "get_agent_feedback"]));
  });

  it("refuses indexer-only tools with INDEXER_REQUIRED", async () => {
    for (const [name, args] of [
      ["leaderboard", {}],
      ["get_registry_stats", {}],
      ["get_agent_feedback", { agent: 1 }],
    ] as const) {
      const response = await session.request("tools/call", { name, arguments: args });
      expect(response.result.isError, name).toBe(true);
      expect(errorBody(response), name).toMatchObject({ code: "INDEXER_REQUIRED" });
    }
  });

  it("fails closed when no allowlisted agent can be read, instead of returning an empty result", async () => {
    const response = await session.request("tools/call", { name: "find_agent", arguments: { query: "seller" } });
    expect(response.result.isError).toBe(true);
    expect(errorBody(response).code).toBe("UPSTREAM_ERROR");
  }, 20_000);

  it("keeps stdout JSON-RPC-only and sends registry warnings to stderr", () => {
    const lines = session.stdout.split("\n").filter((line) => line.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line), `stdout line is not JSON:\n${line}`).not.toThrow();
      expect((JSON.parse(line) as Message).jsonrpc).toBe("2.0");
    }
    expect(session.stderr).toContain("allowlisted agent could not be read");
    expect(session.stdout).not.toContain("allowlisted agent could not be read");
  });
});
