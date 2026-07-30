/**
 * Safe, idempotent MCP-client bootstrap.
 *
 * Claude Code and Codex are registered through their own CLIs. Cursor's JSON
 * config is replaced atomically after an unchanged-content check and an
 * advisory lock shared by setup processes. Existing, conflicting
 * registrations are never overwritten: setup reports the conflict and prints
 * the intended config.
 * Child processes are always spawned with an argv array and `shell: false`.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";

export const SETUP_SERVER_NAME = "stellar-agent";
const PACKAGE_NAME = "stellar-agent-search";
const CURSOR_LOCK_SUFFIX = ".stellar-agent-search.lock";
const CORE_TOOLS = ["find_agent", "rank_agent", "get_agent_profile", "list_services"] as const;

export type SetupClient = "claude" | "cursor" | "codex";
export type SetupScope = "user" | "project";
export type SetupMode = "install" | "check" | "dry-run";
export type SetupAction =
  | "added"
  | "already-configured"
  | "would-add"
  | "missing"
  | "conflict"
  | "manual"
  | "failed";

export interface SetupCommandOptions {
  client?: string;
  scope?: string;
  check?: boolean;
  dryRun?: boolean;
  handshake?: boolean;
  json?: boolean;
  network?: string;
  explorerUrl?: string;
  rpcUrl?: string;
  noVerify?: boolean;
  version: string;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
}

export interface HandshakeResult {
  ok: boolean;
  server?: { name: string; version: string };
  toolCount?: number;
  tools?: string[];
  missingCoreTools?: string[];
  error?: string;
}

export interface SetupRuntime {
  cwd: string;
  homeDir: string;
  execPath: string;
  entrypoint: string;
  nodeVersion: string;
  runCommand: (command: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;
  handshake: (
    command: string,
    args: string[],
    env: Record<string, string>,
    version: string,
  ) => Promise<HandshakeResult>;
}

export interface SetupReport {
  ok: boolean;
  client: SetupClient;
  scope: SetupScope;
  mode: SetupMode;
  action: SetupAction;
  network: "mainnet" | "testnet";
  launch: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  checks: {
    node: { ok: boolean; detail: string };
    entrypoint: { ok: boolean; detail: string };
    launcher: { ok: boolean; detail: string };
    registration: { ok: boolean; detail: string; path?: string };
    handshake?: HandshakeResult;
  };
  instructions: string[];
}

export interface SetupExecution {
  code: number;
  report: SetupReport;
}

interface RegistrationOutcome {
  action: SetupAction;
  ok: boolean;
  detail: string;
  path?: string;
  instructions?: string[];
}

interface ParsedOptions {
  client: SetupClient;
  scope: SetupScope;
  mode: SetupMode;
  handshake: boolean;
  version: string;
  env: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOptions(options: SetupCommandOptions): ParsedOptions {
  if (!options.client) {
    throw new Error("setup requires --client <claude|cursor|codex>");
  }
  if (!(["claude", "cursor", "codex"] as string[]).includes(options.client)) {
    throw new Error(`Unsupported setup client '${options.client}'; expected claude, cursor, or codex`);
  }
  const scope = options.scope ?? "user";
  if (scope !== "user" && scope !== "project") {
    throw new Error(`Unsupported setup scope '${scope}'; expected user or project`);
  }
  if (options.check && options.dryRun) {
    throw new Error("setup --check and --dry-run are mutually exclusive");
  }
  const network = (options.network ?? "mainnet").trim().toLowerCase();
  if (network !== "mainnet" && network !== "testnet") {
    throw new Error(`--network must be 'mainnet' or 'testnet', got '${options.network}'`);
  }

  const env: Record<string, string> = { STELLAR_NETWORK: network };
  if (options.explorerUrl) env.EXPLORER_BASE_URL = validateHttpUrl("--explorer-url", options.explorerUrl);
  if (options.rpcUrl) env.STELLAR_RPC_URL = validateHttpUrl("--rpc-url", options.rpcUrl);
  if (options.noVerify) env.VERIFY_ONCHAIN = "false";
  if (network === "testnet" && !env.EXPLORER_BASE_URL) {
    throw new Error("setup --network testnet requires --explorer-url for a testnet indexer");
  }

  const version = validateExactVersion(options.version);

  return {
    client: options.client as SetupClient,
    scope,
    mode: options.check ? "check" : options.dryRun ? "dry-run" : "install",
    handshake: options.handshake ?? false,
    version,
    env,
  };
}

function validateExactVersion(raw: string): string {
  // Setup writes a long-lived executable command. Reject npm tags, ranges,
  // URLs, and paths even though callers normally pass package.json's version.
  // Prerelease/build identifiers are allowed because they still select one
  // exact immutable npm version.
  const exactSemver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (typeof raw !== "string" || raw.length > 128 || !exactSemver.test(raw)) {
    throw new Error(`setup requires an exact SemVer package version, got '${raw}'`);
  }
  return raw;
}

function validateHttpUrl(flag: string, raw: string): string {
  if (raw.length > 2048) throw new Error(`${flag} is too long`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${flag} must be a valid http(s) URL`);
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    throw new Error(`${flag} must be an http(s) URL without embedded credentials`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function desiredLaunch(env: Record<string, string>, version: string): SetupReport["launch"] {
  return {
    command: "npx",
    // Client configs are long-lived executable supply-chain policy. Pin the
    // exact version that performed setup instead of executing a future `latest`
    // package on every MCP client launch.
    args: ["-y", `${PACKAGE_NAME}@${version}`, "mcp"],
    env,
  };
}

function sameStringArray(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((v, i) => v === expected[i]);
}

function envEquals(value: unknown, expected: Record<string, string>): boolean {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  const expectedKeys = Object.keys(expected);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => value[key] === expected[key])
  );
}

function configMatches(value: unknown, launch: SetupReport["launch"]): boolean {
  if (!isRecord(value)) return false;
  // Client config fields outside this canonical stdio shape can materially
  // change what executes even when command/args/env look identical. In
  // particular, cwd can redirect npx through attacker-controlled npm config or
  // local packages, and type/transport can make a client ignore the stdio
  // command entirely. Accept only the one benign client-added discriminator.
  const allowedKeys = new Set(["type", "command", "args", "env"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (value.type !== undefined && value.type !== "stdio") return false;
  return (
    value.command === launch.command &&
    sameStringArray(value.args, launch.args) &&
    // Explicit MCP env maps are capability boundaries. Accepting a superset
    // would preserve and forward credentials accidentally added by a user or
    // another tool, including STELLAR_PRIVATE_KEY/API tokens.
    envEquals(value.env, launch.env)
  );
}

/** Shell-display quoting only. Execution never uses this string. */
function shellDisplay(argv: string[]): string {
  return argv
    .map((arg) => (/^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function claudeAddArgs(scope: SetupScope, launch: SetupReport["launch"]): string[] {
  return [
    "mcp",
    "add",
    "--scope",
    scope,
    SETUP_SERVER_NAME,
    ...envArgs(launch.env),
    "--",
    launch.command,
    ...launch.args,
  ];
}

function codexAddArgs(launch: SetupReport["launch"]): string[] {
  return [
    "mcp",
    "add",
    SETUP_SERVER_NAME,
    ...envArgs(launch.env),
    "--",
    launch.command,
    ...launch.args,
  ];
}

function desiredJson(launch: SetupReport["launch"]): string {
  return JSON.stringify({ mcpServers: { [SETUP_SERVER_NAME]: launch } }, null, 2);
}

function desiredToml(launch: SetupReport["launch"]): string {
  const env = Object.entries(launch.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join(", ");
  return [
    `[mcp_servers.${SETUP_SERVER_NAME}]`,
    `command = ${JSON.stringify(launch.command)}`,
    `args = ${JSON.stringify(launch.args)}`,
    `env = { ${env} }`,
  ].join("\n");
}

function claudeConfigFromText(text: string): Record<string, unknown> | null {
  const type = /^\s*Type:\s*(\S+)\s*$/im.exec(text)?.[1]?.toLowerCase();
  const command = /^\s*Command:\s*(.+?)\s*$/im.exec(text)?.[1];
  const argsLine = /^\s*Args:\s*(.*?)\s*$/im.exec(text)?.[1];
  if (type !== "stdio" || !command || argsLine == null) return null;
  const env: Record<string, string> = {};
  const environment = /^\s*Environment:\s*(.*?)\s*$/im.exec(text)?.[1] ?? "";
  for (const pair of environment.split(/\s*,\s*|\s+/).filter(Boolean)) {
    const at = pair.indexOf("=");
    if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return { command, args: argsLine ? argsLine.split(/\s+/) : [], env };
}

async function setupClaude(
  parsed: ParsedOptions,
  launch: SetupReport["launch"],
  runtime: SetupRuntime,
): Promise<RegistrationOutcome> {
  // Claude's `mcp get` health-checks the server and can be slow during an npx
  // cold start. Read the documented user/project config first for a fast,
  // deterministic idempotency check; registration itself still goes through
  // the Claude CLI.
  const configPath = parsed.scope === "project"
    ? join(runtime.cwd, ".mcp.json")
    : join(runtime.homeDir, ".claude.json");
  const kind = await pathKind(configPath);
  if (kind === "symlink" || kind === "other") {
    return {
      action: "manual",
      ok: false,
      path: configPath,
      detail: `Refusing to ask Claude CLI to modify ${kind} config path`,
      instructions: [shellDisplay(["claude", ...claudeAddArgs(parsed.scope, launch)])],
    };
  }
  if (kind === "file") {
    try {
      const root: unknown = JSON.parse(await readFile(configPath, "utf8"));
      if (!isRecord(root)) throw new Error("root is not an object");
      if (root.mcpServers !== undefined && !isRecord(root.mcpServers)) {
        throw new Error("mcpServers is not an object");
      }
      const existing = isRecord(root.mcpServers) ? root.mcpServers[SETUP_SERVER_NAME] : undefined;
      if (existing !== undefined) {
        if (configMatches(existing, launch)) {
          return {
            action: "already-configured",
            ok: true,
            path: configPath,
            detail: "matching Claude Code registration already exists",
          };
        }
        return {
          action: "conflict",
          ok: false,
          path: configPath,
          detail: `Claude Code already has '${SETUP_SERVER_NAME}', but its config does not match; nothing was overwritten`,
          instructions: [
            shellDisplay(["claude", "mcp", "get", SETUP_SERVER_NAME]),
            `Desired registration: ${shellDisplay(["claude", ...claudeAddArgs(parsed.scope, launch)])}`,
          ],
        };
      }
    } catch (error) {
      return {
        action: "manual",
        ok: false,
        path: configPath,
        detail: `Claude config cannot be safely inspected (${(error as Error).message}); nothing was modified`,
        instructions: [shellDisplay(["claude", ...claudeAddArgs(parsed.scope, launch)])],
      };
    }
  }

  const get = await runtime.runCommand("claude", ["mcp", "get", SETUP_SERVER_NAME], 30_000);
  if (get.error) {
    return {
      action: "manual",
      ok: false,
      detail: `Claude CLI unavailable: ${get.error}`,
      instructions: [shellDisplay(["claude", ...claudeAddArgs(parsed.scope, launch)])],
    };
  }
  if (get.code === 0) {
    const actual = claudeConfigFromText(`${get.stdout}\n${get.stderr}`);
    if (actual && configMatches(actual, launch)) {
      return { action: "already-configured", ok: true, path: configPath, detail: "matching Claude Code registration already exists" };
    }
    return {
      action: "conflict",
      ok: false,
      path: configPath,
      detail: `Claude Code already has '${SETUP_SERVER_NAME}', but its config does not match; nothing was overwritten`,
      instructions: [
        shellDisplay(["claude", "mcp", "get", SETUP_SERVER_NAME]),
        `Desired registration: ${shellDisplay(["claude", ...claudeAddArgs(parsed.scope, launch)])}`,
      ],
    };
  }

  const combined = `${get.stdout}\n${get.stderr}`;
  if (!/No MCP server named/i.test(combined)) {
    return {
      action: "failed",
      ok: false,
      detail: `Could not inspect Claude Code registration (exit ${get.code ?? "unknown"})`,
      instructions: [combined.trim()].filter(Boolean),
    };
  }
  const addArgs = claudeAddArgs(parsed.scope, launch);
  if (parsed.mode === "check") {
    return { action: "missing", ok: false, path: configPath, detail: "Claude Code registration is missing", instructions: [shellDisplay(["claude", ...addArgs])] };
  }
  if (parsed.mode === "dry-run") {
    return { action: "would-add", ok: true, path: configPath, detail: "would register Claude Code through its CLI", instructions: [shellDisplay(["claude", ...addArgs])] };
  }
  const add = await runtime.runCommand("claude", addArgs, 30_000);
  if (add.error || add.code !== 0) {
    return {
      action: "failed",
      ok: false,
      detail: `Claude Code registration failed${add.error ? `: ${add.error}` : ` (exit ${add.code})`}`,
      instructions: [`Command: ${shellDisplay(["claude", ...addArgs])}`, `${add.stdout}\n${add.stderr}`.trim()].filter(Boolean),
    };
  }
  return { action: "added", ok: true, path: configPath, detail: `registered Claude Code at ${parsed.scope} scope` };
}

function codexTransport(json: unknown): unknown {
  if (!isRecord(json)) return null;
  return json.transport ?? json;
}

async function setupCodex(
  parsed: ParsedOptions,
  launch: SetupReport["launch"],
  runtime: SetupRuntime,
): Promise<RegistrationOutcome> {
  const addArgs = codexAddArgs(launch);
  if (parsed.scope === "project") {
    const path = join(runtime.cwd, ".codex", "config.toml");
    return {
      action: "manual",
      ok: false,
      path,
      detail: "Codex CLI does not expose a project-scope MCP add operation; no TOML was modified",
      instructions: [`Add this table to ${path}:\n${desiredToml(launch)}`, `User-scope alternative: ${shellDisplay(["codex", ...addArgs])}`],
    };
  }

  const get = await runtime.runCommand("codex", ["mcp", "get", SETUP_SERVER_NAME, "--json"], 15_000);
  if (get.error) {
    return {
      action: "manual",
      ok: false,
      detail: `Codex CLI unavailable: ${get.error}`,
      instructions: [shellDisplay(["codex", ...addArgs]), desiredToml(launch)],
    };
  }
  if (get.code === 0) {
    try {
      const actual = codexTransport(JSON.parse(get.stdout));
      if (configMatches(actual, launch)) {
        return { action: "already-configured", ok: true, detail: "matching Codex registration already exists" };
      }
    } catch {
      // A successful non-JSON response is still a conflict: never overwrite it.
    }
    return {
      action: "conflict",
      ok: false,
      detail: `Codex already has '${SETUP_SERVER_NAME}', but its config does not match; nothing was overwritten`,
      instructions: [
        shellDisplay(["codex", "mcp", "get", SETUP_SERVER_NAME, "--json"]),
        `Desired registration: ${shellDisplay(["codex", ...addArgs])}`,
      ],
    };
  }
  const combined = `${get.stdout}\n${get.stderr}`;
  if (!/No MCP server named/i.test(combined)) {
    return {
      action: "failed",
      ok: false,
      detail: `Could not inspect Codex registration (exit ${get.code ?? "unknown"})`,
      instructions: [combined.trim()].filter(Boolean),
    };
  }
  if (parsed.mode === "check") {
    return { action: "missing", ok: false, detail: "Codex registration is missing", instructions: [shellDisplay(["codex", ...addArgs])] };
  }
  if (parsed.mode === "dry-run") {
    return { action: "would-add", ok: true, detail: "would register Codex through its CLI", instructions: [shellDisplay(["codex", ...addArgs])] };
  }
  const add = await runtime.runCommand("codex", addArgs, 15_000);
  if (add.error || add.code !== 0) {
    return {
      action: "failed",
      ok: false,
      detail: `Codex registration failed${add.error ? `: ${add.error}` : ` (exit ${add.code})`}`,
      instructions: [`Command: ${shellDisplay(["codex", ...addArgs])}`, `${add.stdout}\n${add.stderr}`.trim()].filter(Boolean),
    };
  }
  return { action: "added", ok: true, detail: "registered Codex at user scope" };
}

async function pathKind(path: string): Promise<"missing" | "file" | "symlink" | "other"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function writeJsonAtomic(path: string, original: string | null, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${path}${CURSOR_LOCK_SUFFIX}`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Another setup may be updating ${path}; if none is running, remove the stale lock ${lockPath}`,
      );
    }
    throw error;
  }

  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const data = `${JSON.stringify(value, null, 2)}\n`;
  try {
    let mode = 0o600;
    const currentKind = await pathKind(path);
    if (original === null && currentKind !== "missing") {
      throw new Error(`Config path appeared while setup was running: ${path}`);
    }
    if (original !== null && currentKind !== "file") {
      throw new Error(`Config path type changed while setup was running: ${path}`);
    }
    const current = currentKind === "file" ? await readFile(path, "utf8") : null;
    if (current !== original) throw new Error(`Config changed while setup was running: ${path}`);

    if (currentKind === "file") {
      const info = await lstat(path);
      if (!info.isFile()) throw new Error(`Config path type changed while setup was running: ${path}`);
      mode = info.mode & 0o777;
    }
    await writeFile(temporary, data, { encoding: "utf8", flag: "wx", mode });
    // writeFile's mode is filtered by umask. Set the intended permissions on
    // the private temporary file, not on a path an external editor could swap
    // immediately after rename.
    await chmod(temporary, mode);

    // Recheck after preparing the temporary file. Atomic rename prevents a
    // partially written config, but no portable filesystem compare-and-swap
    // can stop an editor that writes in the final read-to-rename window.
    const finalKind = await pathKind(path);
    if (original === null && finalKind !== "missing") {
      throw new Error(`Config path appeared while setup was running: ${path}`);
    }
    if (original !== null && finalKind !== "file") {
      throw new Error(`Config path type changed while setup was running: ${path}`);
    }
    const finalContent = finalKind === "file" ? await readFile(path, "utf8") : null;
    if (finalContent !== original) throw new Error(`Config changed while setup was running: ${path}`);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

async function setupCursor(
  parsed: ParsedOptions,
  launch: SetupReport["launch"],
  runtime: SetupRuntime,
): Promise<RegistrationOutcome> {
  const path = parsed.scope === "project"
    ? join(runtime.cwd, ".cursor", "mcp.json")
    : join(runtime.homeDir, ".cursor", "mcp.json");
  const kind = await pathKind(path);
  if (kind === "symlink" || kind === "other") {
    return {
      action: "manual",
      ok: false,
      path,
      detail: `Refusing to replace ${kind} config path; nothing was modified`,
      instructions: [`Merge this object into ${path}:\n${desiredJson(launch)}`],
    };
  }

  let original: string | null = null;
  let root: Record<string, unknown> = {};
  if (kind === "file") {
    original = await readFile(path, "utf8");
    try {
      const parsedJson: unknown = JSON.parse(original);
      if (!isRecord(parsedJson)) throw new Error("root is not an object");
      root = parsedJson;
    } catch (error) {
      return {
        action: "manual",
        ok: false,
        path,
        detail: `Cursor config is not strict JSON (${(error as Error).message}); nothing was modified`,
        instructions: [`Merge this object into ${path}:\n${desiredJson(launch)}`],
      };
    }
  }

  const servers = root.mcpServers;
  if (servers !== undefined && !isRecord(servers)) {
    return {
      action: "manual",
      ok: false,
      path,
      detail: "Cursor mcpServers value is not an object; nothing was modified",
      instructions: [`Merge this object into ${path}:\n${desiredJson(launch)}`],
    };
  }
  const serverMap = (servers ?? {}) as Record<string, unknown>;
  const existing = serverMap[SETUP_SERVER_NAME];
  if (existing !== undefined) {
    if (configMatches(existing, launch)) {
      return { action: "already-configured", ok: true, path, detail: "matching Cursor registration already exists" };
    }
    return {
      action: "conflict",
      ok: false,
      path,
      detail: `Cursor already has '${SETUP_SERVER_NAME}', but its config does not match; nothing was overwritten`,
      instructions: [`Desired entry for ${path}:\n${desiredJson(launch)}`],
    };
  }

  if (parsed.mode === "check") {
    return { action: "missing", ok: false, path, detail: "Cursor registration is missing", instructions: [`Merge this object into ${path}:\n${desiredJson(launch)}`] };
  }
  if (parsed.mode === "dry-run") {
    return { action: "would-add", ok: true, path, detail: `would add Cursor registration to ${path}`, instructions: [`Resulting entry:\n${desiredJson(launch)}`] };
  }

  const next = {
    ...root,
    mcpServers: {
      ...serverMap,
      [SETUP_SERVER_NAME]: launch,
    },
  };
  try {
    await writeJsonAtomic(path, original, next);
  } catch (error) {
    return {
      action: "failed",
      ok: false,
      path,
      detail: `Could not safely update Cursor config: ${(error as Error).message}`,
      instructions: [`Merge this object into ${path}:\n${desiredJson(launch)}`],
    };
  }
  return { action: "added", ok: true, path, detail: `added Cursor registration to ${path}` };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function defaultSetupRuntime(): SetupRuntime {
  return {
    cwd: process.cwd(),
    homeDir: homedir(),
    execPath: process.execPath,
    entrypoint: resolve(process.argv[1] ?? ""),
    nodeVersion: process.versions.node,
    runCommand,
    handshake: runHandshake,
  };
}

/** Spawn without a shell and return bounded output. */
export async function runCommand(command: string, args: string[], timeoutMs = 15_000): Promise<CommandResult> {
  return await new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const cap = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-64 * 1024);
    child.stdout.on("data", (chunk: Buffer) => { stdout = cap(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = cap(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.on("error", (error) => finish({ code: null, stdout, stderr, error: error.message, timedOut }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut, error: timedOut ? `timed out after ${timeoutMs}ms` : undefined }));
  });
}

/** Initialize the currently-running package as MCP and list its tools. */
export async function runHandshake(
  command: string,
  args: string[],
  env: Record<string, string>,
  version: string,
): Promise<HandshakeResult> {
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...getDefaultEnvironment(), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "stellar-agent-search-setup", version }, { capabilities: {} });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = (async () => {
      await client.connect(transport);
      const listed = await client.listTools();
      const tools = listed.tools.map((tool) => tool.name).sort();
      const missingCoreTools = CORE_TOOLS.filter((name) => !tools.includes(name));
      const server = client.getServerVersion();
      return {
        ok: missingCoreTools.length === 0,
        server: server ? { name: server.name, version: server.version } : undefined,
        toolCount: tools.length,
        tools,
        missingCoreTools: [...missingCoreTools],
        error: missingCoreTools.length ? `missing core tools: ${missingCoreTools.join(", ")}` : undefined,
      } satisfies HandshakeResult;
    })();
    const deadline = new Promise<HandshakeResult>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout({ ok: false, error: "MCP handshake timed out after 10000ms" }), 10_000);
    });
    return await Promise.race([operation, deadline]);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    if (timeout) clearTimeout(timeout);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

export async function executeSetup(
  options: SetupCommandOptions,
  runtime: SetupRuntime = defaultSetupRuntime(),
): Promise<SetupExecution> {
  const parsed = parseOptions(options);
  const launch = desiredLaunch(parsed.env, parsed.version);
  const major = Number(runtime.nodeVersion.split(".")[0]);
  const nodeCheck = { ok: Number.isFinite(major) && major >= 22, detail: `v${runtime.nodeVersion} (>=22 required)` };
  const entrypointOk = await fileExists(runtime.entrypoint);
  const entrypointCheck = { ok: entrypointOk, detail: entrypointOk ? runtime.entrypoint : `not found: ${runtime.entrypoint}` };
  const launcher = await runtime.runCommand("npx", ["--version"], 5_000);
  const launcherCheck = {
    ok: launcher.code === 0 && !launcher.error,
    detail: launcher.code === 0 ? `npx ${launcher.stdout.trim()}` : `npx unavailable${launcher.error ? `: ${launcher.error}` : ""}`,
  };

  let registration: RegistrationOutcome;
  if (!nodeCheck.ok || !entrypointCheck.ok || !launcherCheck.ok) {
    registration = { action: "failed", ok: false, detail: "runtime availability checks failed; no client config was modified" };
  } else if (parsed.client === "claude") {
    registration = await setupClaude(parsed, launch, runtime);
  } else if (parsed.client === "cursor") {
    registration = await setupCursor(parsed, launch, runtime);
  } else {
    registration = await setupCodex(parsed, launch, runtime);
  }

  let handshake: HandshakeResult | undefined;
  if (parsed.handshake && nodeCheck.ok && entrypointCheck.ok) {
    handshake = await runtime.handshake(
      runtime.execPath,
      [runtime.entrypoint, "mcp"],
      parsed.env,
      parsed.version,
    );
  }
  const ok = nodeCheck.ok && entrypointCheck.ok && launcherCheck.ok && registration.ok && (!handshake || handshake.ok);
  const report: SetupReport = {
    ok,
    client: parsed.client,
    scope: parsed.scope,
    mode: parsed.mode,
    action: registration.action,
    network: parsed.env.STELLAR_NETWORK as "mainnet" | "testnet",
    launch,
    checks: {
      node: nodeCheck,
      entrypoint: entrypointCheck,
      launcher: launcherCheck,
      registration: { ok: registration.ok, detail: registration.detail, path: registration.path },
      handshake,
    },
    instructions: registration.instructions ?? [],
  };
  return { code: ok ? 0 : 1, report };
}

export function formatSetupReport(report: SetupReport): string {
  const lines = [
    `${report.ok ? "✔" : "✗"} setup     ${report.client} · ${report.scope} · ${report.mode} · ${report.action}`,
    `${report.checks.node.ok ? "✔" : "✗"} node      ${report.checks.node.detail}`,
    `${report.checks.entrypoint.ok ? "✔" : "✗"} package   ${report.checks.entrypoint.detail}`,
    `${report.checks.launcher.ok ? "✔" : "✗"} launcher  ${report.checks.launcher.detail}`,
    `${report.checks.registration.ok ? "✔" : "✗"} config    ${report.checks.registration.detail}`,
  ];
  if (report.checks.registration.path) lines.push(`ℹ path      ${report.checks.registration.path}`);
  const handshake = report.checks.handshake;
  if (handshake) {
    lines.push(
      `${handshake.ok ? "✔" : "✗"} handshake ${handshake.ok ? `${handshake.server?.name ?? "server"} · ${handshake.toolCount ?? 0} tools` : handshake.error ?? "failed"}`,
    );
    if (handshake.tools?.length) lines.push(`ℹ tools     ${handshake.tools.join(", ")}`);
  }
  for (const instruction of report.instructions) lines.push(`ℹ ${instruction}`);
  if (report.action === "added") lines.push("ℹ Restart the client, then confirm stellar-agent appears in its MCP panel.");
  return lines.join("\n");
}
