/**
 * skill-sync.test.ts — bind skills/mcp/SKILL.md to the code it documents.
 *
 * The skill is shipped from this repository and fetched by `npx skills add`
 * straight off the default branch, so a stale SKILL.md reaches users with no
 * release step in between: an agent reads it to decide what it may call, and
 * then calls a tool that does not exist (or never discovers one that does).
 *
 * That drift is not hypothetical — 0.1.0 shipped a SKILL.md claiming 12 tools
 * when there were 13, plus a `stellar8004://search/{query}` resource that was
 * never implemented. CONTRIBUTING.md asks contributors to update the counts by
 * hand; this suite is what makes forgetting a red build instead of a user-facing
 * bug, and it is the enforcement docs/evidence.md points at.
 *
 * Counts are read out of the source rather than a fixture on purpose: the test
 * has to fail when `src/` changes and SKILL.md does not.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const SKILL = read("skills", "mcp", "SKILL.md");
const PKG = JSON.parse(read("package.json")) as {
  name: string;
  version: string;
};

/** Minimal frontmatter reader — the skill format is a fixed, flat YAML head. */
function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) throw new Error("SKILL.md has no YAML frontmatter");
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^\s*([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const FM = frontmatter(SKILL);

/** Entries of the REGISTRARS array in src/tools/index.ts. */
function toolCount(): number {
  const src = read("src", "tools", "index.ts");
  const block = /const REGISTRARS[\s\S]*?=\s*\[([\s\S]*?)\n\];/.exec(src);
  if (!block) throw new Error("could not locate the REGISTRARS array");
  return block[1]
    .split("\n")
    .filter((l) => /^\s*register[A-Za-z]+,\s*$/.test(l)).length;
}

const countCalls = (src: string, method: string) =>
  src.split(`server.${method}(`).length - 1;

describe("SKILL.md stays in sync with the code it documents", () => {
  it("declares the same version as package.json", () => {
    // The skill is served from this repo precisely so it is versioned with the
    // server; a hand-maintained version that drifts makes that claim false.
    expect(FM.version).toBe(PKG.version);
  });

  it("names the package it installs, with a range that admits the current version", () => {
    expect(FM["mcp-package"]).toBe(PKG.name);

    // A caret range on a 0.x package pins the minor (^0.1.0 -> >=0.1.0 <0.2.0),
    // so it would exclude the very next release. Require an open lower bound.
    const pin = FM["mcp-package-version"];
    expect(pin, "0.x caret pins would exclude the next minor release").not.toMatch(/^\^0\./);
    expect(pin).toMatch(/^>=\s*\d+\.\d+\.\d+$/);

    const [, floor] = /^>=\s*(\d+\.\d+\.\d+)$/.exec(pin)!;
    const asNums = (v: string) => v.split(".").map(Number);
    const [fa, fb, fc] = asNums(floor);
    const [pa, pb, pc] = asNums(PKG.version);
    expect(pa * 1e6 + pb * 1e3 + pc).toBeGreaterThanOrEqual(fa * 1e6 + fb * 1e3 + fc);
  });

  it("states the real number of tools", () => {
    const n = toolCount();
    expect(n).toBeGreaterThan(0);
    // Every place the skill spells the count out loud must agree with src/.
    expect(SKILL).toContain(`**${n} read tools.**`);
    expect(SKILL).toContain(`will list all ${n}`);
  });

  it("states the real number of resources", () => {
    const n = countCalls(read("src", "resources", "index.ts"), "registerResource");
    expect(n).toBeGreaterThan(0);
    expect(SKILL).toContain(`**${n} resources** total`);
  });

  it("documents only resource URI templates that are actually registered", () => {
    const src = read("src", "resources", "index.ts");
    // A citation is a *complete* URI. The skill also mentions the scheme bare
    // ("stellar8004://") and names one URI it deliberately says does NOT exist
    // ("stellar8004://search/…"); both are illustrative, not claims of a
    // registered resource, and the ellipsis is what distinguishes them.
    const cited = new Set(
      [...SKILL.matchAll(/stellar8004:\/\/[\w/{}…-]*/g)]
        .map((m) => m[0])
        .filter((u) => !u.includes("…") && !u.endsWith("/") && u !== "stellar8004://"),
    );
    expect(cited.size).toBeGreaterThan(0);
    const missing = [...cited].filter((uri) => !src.includes(uri));
    expect(missing, `SKILL.md cites unregistered resources: ${missing.join(", ")}`).toEqual([]);
  });

  it("documents only prompts that are actually registered", () => {
    const src = read("src", "prompts", "index.ts");
    const registered = countCalls(src, "registerPrompt");
    expect(registered).toBeGreaterThan(0);

    // Slash-command names the skill advertises, minus the client built-in /mcp.
    const cited = new Set(
      [...SKILL.matchAll(/`\/([a-z][a-z0-9-]+)`/g)]
        .map((m) => m[1])
        .filter((n) => n !== "mcp" && !n.startsWith("8004") && !n.startsWith("x402")),
    );
    const missing = [...cited].filter((n) => !src.includes(n));
    expect(missing, `SKILL.md cites unregistered prompts: ${missing.join(", ")}`).toEqual([]);
  });

  /** snake_case names in the skill that are Soroban contract methods, not our tools. */
  const CONTRACT_METHODS = new Set(["get_summary", "get_clients_paginated"]);

  /** `registerFooBar` -> `foo_bar`, i.e. the tool name a registrar registers. */
  const registrarToToolName = (registrar: string) =>
    registrar
      .replace(/^register/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();

  it("documents every tool that is actually registered", () => {
    // The direction that bites hardest: a tool ships and the agent-facing doc
    // never mentions it, so no client ever calls it.
    const index = read("src", "tools", "index.ts");
    const block = /const REGISTRARS[\s\S]*?=\s*\[([\s\S]*?)\n\];/.exec(index)![1];
    const registered = [...block.matchAll(/^\s*(register[A-Za-z]+),\s*$/gm)].map((m) =>
      registrarToToolName(m[1]),
    );
    expect(registered.length).toBe(toolCount());

    const undocumented = registered.filter((name) => !SKILL.includes(`\`${name}\``));
    expect(undocumented, `tools missing from SKILL.md: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("documents only tools that are actually registered", () => {
    const index = read("src", "tools", "index.ts");
    // Tool names in the skill are snake_case in backticks.
    const cited = new Set(
      [...SKILL.matchAll(/`([a-z]+(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]),
    );
    const missing = [...cited].filter((name) => {
      if (CONTRACT_METHODS.has(name)) return false;
      const camel = name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      const registrar = `register${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
      return !index.includes(registrar);
    });
    expect(missing, `SKILL.md cites unregistered tools: ${missing.join(", ")}`).toEqual([]);
  });
});
