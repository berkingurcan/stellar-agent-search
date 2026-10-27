/**
 * ci-scripts.test.ts — the scripts the workflows run. testnet-smoke and mainnet-parity
 * need the live network, so they run only nightly or on demand; this keeps a broken import
 * or a renamed file from waiting until then to surface. surface-compat has its own suite.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts", "ci");
const WORKFLOWS = join(ROOT, ".github", "workflows");

function run(script: string, args: string[] = []) {
  const env = { ...process.env };
  delete env.REGISTRY_AGENT_IDS;
  delete env.SMOKE_QUERY;
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: "utf8", env, timeout: 30_000 });
}

describe("CI scripts", () => {
  it("testnet-smoke loads and asks for its inputs instead of guessing them", () => {
    const result = run("testnet-smoke.mjs");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("set REGISTRY_AGENT_IDS and SMOKE_QUERY");
  });

  it("mainnet-parity loads and asks for the two builds", () => {
    const result = run("mainnet-parity.mjs");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: mainnet-parity.mjs <base-dist> <head-dist>");
  });

  it("every script is run by a workflow, and every workflow runs a script that exists", () => {
    const workflows = readdirSync(WORKFLOWS).map((name) => readFileSync(join(WORKFLOWS, name), "utf8")).join("\n");
    const referenced = [...new Set([...workflows.matchAll(/scripts\/ci\/([\w-]+\.mjs)/g)].map((m) => m[1]))].sort();
    expect(referenced).toEqual(readdirSync(SCRIPTS).filter((name) => name.endsWith(".mjs")).sort());
  });
});
