import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFlags } from "../src/cli/index.js";
import {
  executeSetup,
  formatSetupReport,
  type CommandResult,
  type SetupRuntime,
} from "../src/cli/setup.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "stellar-agent-market-setup-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, stdout: "10.9.0\n", stderr: "", ...overrides };
}

function runtime(
  overrides: Partial<SetupRuntime> = {},
): SetupRuntime {
  return {
    cwd: process.cwd(),
    homeDir: process.cwd(),
    execPath: process.execPath,
    entrypoint: fileURLToPath(import.meta.url),
    nodeVersion: process.versions.node,
    runCommand: vi.fn(async () => commandResult()),
    handshake: vi.fn(async () => ({
      ok: true,
      server: { name: "stellar-agent-market", version: "0.1.0" },
      toolCount: 13,
      tools: ["find_agent", "rank_agent", "get_agent_profile", "list_services"],
      missingCoreTools: [],
    })),
    ...overrides,
  };
}

describe("setup flag parsing", () => {
  it("parses setup-only value and boolean flags", () => {
    const flags = parseFlags([
      "setup",
      "--client",
      "cursor",
      "--scope",
      "project",
      "--dry-run",
      "--handshake",
      "--json",
    ]);
    expect(flags).toMatchObject({
      command: "setup",
      client: "cursor",
      scope: "project",
      dryRun: true,
      handshake: true,
      json: true,
    });
  });

  it("rejects a missing client and mutually exclusive modes", async () => {
    await expect(executeSetup({ version: "0.1.0" }, runtime())).rejects.toThrow("requires --client");
    await expect(
      executeSetup({ client: "cursor", check: true, dryRun: true, version: "0.1.0" }, runtime()),
    ).rejects.toThrow("mutually exclusive");
  });

  it("rejects embedded URL credentials and incomplete testnet config", async () => {
    await expect(
      executeSetup(
        { client: "cursor", explorerUrl: "https://user:secret@example.test", version: "0.1.0" },
        runtime(),
      ),
    ).rejects.toThrow("without embedded credentials");
    await expect(
      executeSetup({ client: "cursor", network: "testnet", version: "0.1.0" }, runtime()),
    ).rejects.toThrow("requires --explorer-url");
  });

  it("requires an exact immutable package version for persistent launchers", async () => {
    for (const version of ["latest", "^0.1.0", "0.1.x", "0.2.0-01", "https://example.test/pkg.tgz"]) {
      await expect(
        executeSetup({ client: "cursor", dryRun: true, version }, runtime()),
      ).rejects.toThrow("exact SemVer package version");
    }

    const prerelease = await executeSetup(
      { client: "cursor", dryRun: true, version: "0.2.0-rc.1" },
      runtime(),
    );
    expect(prerelease.report.launch.args).toEqual([
      "-y",
      "stellar-agent-market@0.2.0-rc.1",
      "mcp",
    ]);
  });
});

describe("Cursor setup", () => {
  it("atomically merges a project config and is idempotent", async () => {
    const cwd = await temporaryDirectory();
    const configDirectory = join(cwd, ".cursor");
    const configPath = join(configDirectory, "mcp.json");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configPath, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other" } } }));
    const rt = runtime({ cwd, homeDir: cwd });

    const first = await executeSetup(
      { client: "cursor", scope: "project", version: "0.1.0" },
      rt,
    );
    expect(first.code).toBe(0);
    expect(first.report.action).toBe("added");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.other).toEqual({ command: "other" });
    expect(config.mcpServers["stellar-agent"]).toEqual({
      command: "npx",
      args: ["-y", "stellar-agent-market@0.1.0", "mcp"],
      env: { STELLAR_NETWORK: "mainnet" },
    });

    const second = await executeSetup(
      { client: "cursor", scope: "project", version: "0.1.0" },
      rt,
    );
    expect(second.code).toBe(0);
    expect(second.report.action).toBe("already-configured");
  });

  it("never overwrites a conflicting registration", async () => {
    const cwd = await temporaryDirectory();
    const configDirectory = join(cwd, ".cursor");
    const configPath = join(configDirectory, "mcp.json");
    await mkdir(configDirectory, { recursive: true });
    const original = '{"mcpServers":{"stellar-agent":{"command":"custom"}}}\n';
    await writeFile(configPath, original);

    const result = await executeSetup(
      { client: "cursor", scope: "project", version: "0.1.0" },
      runtime({ cwd, homeDir: cwd }),
    );
    expect(result.code).toBe(1);
    expect(result.report.action).toBe("conflict");
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("treats every extra explicit env value as a conflict, including secrets", async () => {
    const cwd = await temporaryDirectory();
    const configDirectory = join(cwd, ".cursor");
    const configPath = join(configDirectory, "mcp.json");
    await mkdir(configDirectory, { recursive: true });
    const original = JSON.stringify({
      mcpServers: {
        "stellar-agent": {
          command: "npx",
          args: ["-y", "stellar-agent-market@0.1.0", "mcp"],
          env: {
            STELLAR_NETWORK: "mainnet",
            STELLAR_PRIVATE_KEY: "S-DO-NOT-FORWARD",
          },
        },
      },
    });
    await writeFile(configPath, original);

    const result = await executeSetup(
      { client: "cursor", scope: "project", version: "0.1.0" },
      runtime({ cwd, homeDir: cwd }),
    );
    expect(result.code).toBe(1);
    expect(result.report.action).toBe("conflict");
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it.each([
    ["cwd", { cwd: "/tmp/attacker-controlled" }],
    ["non-stdio type", { type: "http", url: "https://attacker.invalid/mcp" }],
    ["nested transport", { transport: { type: "stdio", command: "other" } }],
    ["disabled launcher", { disabled: true }],
  ])("rejects an otherwise matching registration with execution-changing %s", async (_label, extra) => {
    const cwd = await temporaryDirectory();
    const configDirectory = join(cwd, ".cursor");
    const configPath = join(configDirectory, "mcp.json");
    await mkdir(configDirectory, { recursive: true });
    const entry = {
      command: "npx",
      args: ["-y", "stellar-agent-market@0.1.0", "mcp"],
      env: { STELLAR_NETWORK: "mainnet" },
      ...extra,
    };
    const original = JSON.stringify({ mcpServers: { "stellar-agent": entry } });
    await writeFile(configPath, original);

    const result = await executeSetup(
      { client: "cursor", scope: "project", version: "0.1.0" },
      runtime({ cwd, homeDir: cwd }),
    );

    expect(result.code).toBe(1);
    expect(result.report.action).toBe("conflict");
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("serializes setup writers with an advisory lock and leaves config untouched", async () => {
    const cwd = await temporaryDirectory();
    const configDirectory = join(cwd, ".cursor");
    const configPath = join(configDirectory, "mcp.json");
    const lockPath = `${configPath}.stellar-agent-market.lock`;
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configPath, "{}\n");
    await writeFile(lockPath, "another setup owns this lock\n", { mode: 0o600 });

    const result = await executeSetup(
      { client: "cursor", scope: "project", version: "0.1.0" },
      runtime({ cwd, homeDir: cwd }),
    );
    expect(result.code).toBe(1);
    expect(result.report.action).toBe("failed");
    expect(result.report.checks.registration.detail).toContain("Another setup may be updating");
    expect(await readFile(configPath, "utf8")).toBe("{}\n");
    expect(await readFile(lockPath, "utf8")).toContain("another setup owns");
  });

  it("does not rewrite JSONC or a symlink", async () => {
    const cwd = await temporaryDirectory();
    const configDirectory = join(cwd, ".cursor");
    const configPath = join(configDirectory, "mcp.json");
    await mkdir(configDirectory, { recursive: true });
    const jsonc = '{\n  // user comment\n  "mcpServers": {}\n}\n';
    await writeFile(configPath, jsonc);
    const rt = runtime({ cwd, homeDir: cwd });

    const malformed = await executeSetup(
      { client: "cursor", scope: "project", version: "0.1.0" },
      rt,
    );
    expect(malformed.report.action).toBe("manual");
    expect(await readFile(configPath, "utf8")).toBe(jsonc);

    await rm(configPath);
    const target = join(cwd, "real-config.json");
    await writeFile(target, "{}\n");
    await symlink(target, configPath);
    const linked = await executeSetup(
      { client: "cursor", scope: "project", version: "0.1.0" },
      rt,
    );
    expect(linked.report.action).toBe("manual");
    expect(await readFile(target, "utf8")).toBe("{}\n");
  });

  it("supports non-mutating check and dry-run", async () => {
    const cwd = await temporaryDirectory();
    const rt = runtime({ cwd, homeDir: cwd });
    const check = await executeSetup(
      { client: "cursor", scope: "project", check: true, version: "0.1.0" },
      rt,
    );
    expect(check.report.action).toBe("missing");
    expect(check.code).toBe(1);

    const dryRun = await executeSetup(
      { client: "cursor", scope: "project", dryRun: true, version: "0.1.0" },
      rt,
    );
    expect(dryRun.report.action).toBe("would-add");
    expect(dryRun.code).toBe(0);
    await expect(readFile(join(cwd, ".cursor", "mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("CLI-backed setup", () => {
  it("registers Claude directly with an argv array", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const rt = runtime({
      runCommand: vi.fn(async (command, args) => {
        calls.push({ command, args });
        if (command === "npx") return commandResult();
        if (args[1] === "get") return commandResult({ code: 1, stdout: "", stderr: 'No MCP server named "stellar-agent".' });
        return commandResult({ stdout: "Added" });
      }),
    });
    const result = await executeSetup(
      {
        client: "claude",
        scope: "project",
        explorerUrl: "https://example.test/api?literal=$(never-executed)",
        version: "0.1.0",
      },
      rt,
    );
    expect(result.code).toBe(0);
    expect(result.report.action).toBe("added");
    expect(calls[2]).toEqual({
      command: "claude",
      args: [
        "mcp", "add", "--scope", "project",
        "stellar-agent",
        "--env", "EXPLORER_BASE_URL=https://example.test/api?literal=$(never-executed)",
        "--env", "STELLAR_NETWORK=mainnet",
        "--", "npx", "-y", "stellar-agent-market@0.1.0", "mcp",
      ],
    });
  });

  it("uses Claude's config for a fast idempotency check", async () => {
    const homeDir = await temporaryDirectory();
    await writeFile(
      join(homeDir, ".claude.json"),
      JSON.stringify({
        firstStartTime: "preserved",
        mcpServers: {
          "stellar-agent": {
            type: "stdio",
            command: "npx",
            args: ["-y", "stellar-agent-market@0.1.0", "mcp"],
            env: { STELLAR_NETWORK: "mainnet" },
          },
        },
      }),
    );
    const runCommand = vi.fn(async () => commandResult());
    const result = await executeSetup(
      { client: "claude", scope: "user", version: "0.1.0" },
      runtime({ homeDir, runCommand }),
    );
    expect(result.report.action).toBe("already-configured");
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("npx", ["--version"], 5_000);
  });

  it("recognizes an existing matching Claude registration", async () => {
    const rt = runtime({
      runCommand: vi.fn(async (command) => command === "npx"
        ? commandResult()
        : commandResult({
            stdout: [
              "stellar-agent:",
              "  Type: stdio",
              "  Command: npx",
              "  Args: -y stellar-agent-market@0.1.0 mcp",
              "  Environment: STELLAR_NETWORK=mainnet",
            ].join("\n"),
          })),
    });
    const result = await executeSetup({ client: "claude", version: "0.1.0" }, rt);
    expect(result.code).toBe(0);
    expect(result.report.action).toBe("already-configured");
  });

  it("recognizes matching Codex JSON and refuses project-scope mutation", async () => {
    const rt = runtime({
      runCommand: vi.fn(async (command) => command === "npx"
        ? commandResult()
        : commandResult({
            stdout: JSON.stringify({
              name: "stellar-agent",
              transport: {
                type: "stdio",
                command: "npx",
                args: ["-y", "stellar-agent-market@0.1.0", "mcp"],
                env: { STELLAR_NETWORK: "mainnet" },
              },
            }),
          })),
    });
    const existing = await executeSetup({ client: "codex", version: "0.1.0" }, rt);
    expect(existing.report.action).toBe("already-configured");

    const project = await executeSetup(
      { client: "codex", scope: "project", version: "0.1.0" },
      rt,
    );
    expect(project.code).toBe(1);
    expect(project.report.action).toBe("manual");
    expect(project.report.instructions.join("\n")).toContain("[mcp_servers.stellar-agent]");
  });
});

describe("availability and handshake", () => {
  it("does not modify config when npx is unavailable", async () => {
    const cwd = await temporaryDirectory();
    const rt = runtime({
      cwd,
      homeDir: cwd,
      runCommand: vi.fn(async () => commandResult({ code: null, stdout: "", error: "ENOENT" })),
    });
    const result = await executeSetup(
      { client: "cursor", scope: "project", version: "0.1.0" },
      rt,
    );
    expect(result.code).toBe(1);
    expect(result.report.action).toBe("failed");
    await expect(readFile(join(cwd, ".cursor", "mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes the current entrypoint to the optional handshake and surfaces failure", async () => {
    const cwd = await temporaryDirectory();
    const handshake = vi.fn(async () => ({ ok: false, error: "missing core tools" }));
    const rt = runtime({ cwd, homeDir: cwd, handshake });
    const result = await executeSetup(
      { client: "cursor", scope: "project", dryRun: true, handshake: true, version: "0.1.0" },
      rt,
    );
    expect(result.code).toBe(1);
    expect(handshake).toHaveBeenCalledWith(
      process.execPath,
      [fileURLToPath(import.meta.url), "mcp"],
      { STELLAR_NETWORK: "mainnet" },
      "0.1.0",
    );
    expect(formatSetupReport(result.report)).toContain("missing core tools");
  });
});
