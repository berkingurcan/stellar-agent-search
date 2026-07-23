/**
 * index.ts — the single `stellar-agent-mcp` bin entry (shebang injected by tsup).
 *
 * Dual CLI + MCP dispatch (research/B §3.4):
 *   - A known CLI subcommand (find/profile/rank/services/doctor) → human CLI.
 *   - `serve` / `mcp` / `--stdio`                                → explicit MCP stdio server.
 *   - No args on a TTY                                           → friendly help.
 *   - No args on a non-TTY (how every MCP client launches us)    → MCP stdio server.
 *   - --help / --version                                        → CLI (help / version).
 *
 * stdout is JSON-RPC ONLY in server mode; every diagnostic goes to stderr.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFlags, runCli, startMcpServer, printHelp, type CliFlags } from "./cli/index.js";
import { DEFAULT_SERVER_VERSION } from "./server.js";

/** Resolve the package version from the on-disk package.json (dist/.. or src/..). */
function getVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? DEFAULT_SERVER_VERSION;
  } catch {
    return DEFAULT_SERVER_VERSION;
  }
}

/** Commands that mean "start the MCP server", not "run a CLI subcommand". */
const SERVE_COMMANDS = new Set(["serve", "mcp"]);
/** Human CLI subcommands. */
const CLI_COMMANDS = new Set(["find", "rank", "profile", "services", "doctor"]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const version = getVersion();

  let flags: CliFlags;
  try {
    flags = parseFlags(argv);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    printHelp();
    process.exitCode = 2;
    return;
  }

  // --version / --help are always CLI concerns, regardless of stdin.
  if (flags.version || flags.help) {
    process.exitCode = await runCli(flags, version);
    return;
  }

  // Explicit server start: `serve`, `mcp`, or a bare `--stdio`.
  if ((flags.command && SERVE_COMMANDS.has(flags.command)) || (!flags.command && flags.stdio)) {
    await startMcpServer(flags, version);
    return;
  }

  // Known human CLI subcommand.
  if (flags.command && CLI_COMMANDS.has(flags.command)) {
    process.exitCode = await runCli(flags, version);
    return;
  }

  // An unrecognized subcommand → CLI, which prints help + exits non-zero.
  if (flags.command) {
    process.exitCode = await runCli(flags, version);
    return;
  }

  // No subcommand: TTY → friendly help; non-TTY (client launch) → MCP server.
  if (process.stdin.isTTY) {
    printHelp();
    return;
  }
  await startMcpServer(flags, version);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
