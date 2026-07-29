/**
 * stdout-clean.test.ts — the single most important MCP invariant: over stdio,
 * stdout carries ONLY newline-delimited JSON-RPC. A single stray console.log
 * (or a logger accidentally writing to stdout) corrupts the framing and breaks
 * every client. Non-negotiable #2: all logs go to stderr.
 *
 * We spawn the REAL built binary (dist/index.js) exactly the way an MCP client
 * launches it, drive a full initialize → initialized → tools/list handshake,
 * and assert:
 *   1. every non-empty stdout line is valid JSON with jsonrpc === "2.0",
 *   2. the initialize result + tools/list are present and well-formed,
 *   3. human diagnostics (the "ready" banner) appear on stderr, never stdout.
 *
 * Offline: initialize + tools/list touch no network (no explorer / RPC calls),
 * so this passes in CI with no connectivity.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BIN = join(ROOT, "dist", "index.js");

interface Handshake {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Spawn the built server, run one handshake, return captured streams. */
function runHandshake(): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, STELLAR_NETWORK: "mainnet", VERIFY_ONCHAIN: "false" },
    });

    let stdout = "";
    let stderr = "";
    let sawTools = false;
    const done = (): void => {
      if (!child.killed) child.kill("SIGTERM");
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
      // Once we've seen the tools/list response (id 2), we have enough.
      if (!sawTools && stdout.includes('"id":2')) {
        sawTools = true;
        setTimeout(done, 50);
      }
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));

    const send = (obj: unknown): void => {
      child.stdin.write(JSON.stringify(obj) + "\n");
    };

    // Drive the MCP handshake.
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stdout-clean-test", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    // Safety net so a hang can't wedge the suite.
    setTimeout(done, 8000);
  });
}

describe("stdio server keeps stdout JSON-RPC-only", () => {
  beforeAll(() => {
    if (!existsSync(BIN)) {
      execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
    }
  }, 120_000);

  let hs: Handshake;
  beforeAll(async () => {
    hs = await runHandshake();
  }, 20_000);

  it("emits at least one stdout line", () => {
    const lines = hs.stdout.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("EVERY non-empty stdout line is valid JSON-RPC 2.0 (no stray text)", () => {
    const lines = hs.stdout.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      let parsed: unknown;
      expect(
        () => {
          parsed = JSON.parse(line);
        },
        `stdout line is not JSON — a stray write corrupted the stream:\n${line}`,
      ).not.toThrow();
      expect((parsed as { jsonrpc?: string }).jsonrpc).toBe("2.0");
    }
  });

  it("returns a well-formed initialize result identifying this server", () => {
    const msgs = hs.stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, any>);
    const init = msgs.find((m) => m.id === 1);
    expect(init).toBeDefined();
    expect(init!.result.serverInfo.name).toBe("stellar-agent-mcp");
    expect(init!.result.capabilities.tools).toEqual({ listChanged: false });
    expect(init!.result.capabilities.resources).toEqual({ listChanged: false });
    expect(init!.result.capabilities.prompts).toEqual({ listChanged: false });
  });

  it("lists the read-only tools over the protocol (registration path is clean)", () => {
    const msgs = hs.stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, any>);
    const list = msgs.find((m) => m.id === 2);
    expect(list).toBeDefined();
    const names = (list!.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("find_agent");
    expect(names).toContain("get_agent_profile");
    expect(names.length).toBeGreaterThanOrEqual(4);
  });

  it("writes human diagnostics to stderr, never stdout", () => {
    // The startup banner is a diagnostic; it MUST be on stderr.
    expect(hs.stderr).toContain("MCP stdio server ready");
    expect(hs.stdout).not.toContain("MCP stdio server ready");
    // And stdout must never contain obvious non-JSON log noise.
    expect(hs.stdout).not.toMatch(/read-only, keyless/);
  });
});
