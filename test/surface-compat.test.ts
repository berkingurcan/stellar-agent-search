/**
 * surface-compat.test.ts — scripts/ci/surface-compat.mjs, which the `MCP surface` workflow
 * runs against the base branch's snapshot. Each case edits a copy of the real committed
 * snapshot, so the checker is exercised on the schema shapes the server actually emits.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "ci", "surface-compat.mjs");
const SNAPSHOT = JSON.parse(readFileSync(join(ROOT, "test", "__surface__", "mcp-surface.json"), "utf8"));
const DIR = mkdtempSync(join(tmpdir(), "surface-compat-"));

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

type Surface = typeof SNAPSHOT;
let runs = 0;

/** Run the checker: base is the snapshot after `opts.base`, head the snapshot after `edit`. */
function compat(edit: (head: Surface) => void, opts: { base?: (base: Surface) => void; flags?: string[] } = {}) {
  const base = structuredClone(SNAPSHOT);
  opts.base?.(base);
  const head = structuredClone(SNAPSHOT);
  edit(head);
  const basePath = join(DIR, `base-${runs}.json`);
  const headPath = join(DIR, `head-${runs++}.json`);
  writeFileSync(basePath, JSON.stringify(base));
  writeFileSync(headPath, JSON.stringify(head));
  // Never append to the real job summary when this suite runs inside GitHub Actions.
  const { GITHUB_STEP_SUMMARY: _summary, ...env } = process.env;
  const result = spawnSync(process.execPath, [SCRIPT, basePath, headPath, ...(opts.flags ?? [])], {
    encoding: "utf8",
    env,
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

const tool = (surface: Surface, name: string) => surface.tools.find((t: { name: string }) => t.name === name);
const findInput = (surface: Surface) => tool(surface, "find_agent").inputSchema;
const findOutput = (surface: Surface) => tool(surface, "find_agent").outputSchema;

describe("surface-compat passes what an existing client can live with", () => {
  it("reports no changes for an identical snapshot", () => {
    const { status, out } = compat(() => {});
    expect(status).toBe(0);
    expect(out).toContain("No changes to the MCP surface.");
  });

  it("treats a new optional output field as additive (the registry-mode `source` field)", () => {
    const withoutSource = (surface: Surface) => {
      for (const t of surface.tools) delete t.outputSchema?.properties?.source;
    };
    const { status, out } = compat(() => {}, { base: withoutSource });
    expect(status).toBe(0);
    expect(out).toContain("find_agent output.source: new optional property");
    expect(out).toContain("No breaking change");
  });

  it("treats a new tool, a new optional input and a looser input bound as additive", () => {
    const { status, out } = compat((head) => {
      head.tools.push({ ...structuredClone(tool(head, "find_agent")), name: "find_agent_v2" });
      findInput(head).properties.region = { type: "string" };
      findInput(head).properties.limit.maximum = 100;
    });
    expect(status).toBe(0);
    expect(out).toMatch(/tool find_agent_v2: added/);
    expect(out).toMatch(/find_agent input\.region: new optional property/);
    expect(out).toMatch(/find_agent input\.limit: maximum 50 → 100/);
  });

  it("lists a wording change without failing", () => {
    const { status, out } = compat((head) => {
      tool(head, "find_agent").description += " Now with more words.";
      head.instructions.registry += " Extra.";
    });
    expect(status).toBe(0);
    expect(out).toMatch(/tool find_agent: description changed/);
    expect(out).toMatch(/instructions \(registry\) changed/);
  });
});

describe("surface-compat fails what would break an existing client", () => {
  const cases: Array<[string, (head: Surface) => void, RegExp]> = [
    ["a removed tool", (h) => void h.tools.splice(h.tools.indexOf(tool(h, "leaderboard")), 1), /tool leaderboard: removed/],
    ["a new required input", (h) => {
      findInput(h).properties.region = { type: "string" };
      findInput(h).required.push("region");
    }, /find_agent input\.region: new required property/],
    ["an input that became required", (h) => void findInput(h).required.push("limit"), /find_agent input\.limit: now required/],
    ["a removed input", (h) => void delete findInput(h).properties.x402, /find_agent input\.x402: removed/],
    ["a narrower input enum", (h) => {
      findInput(h).properties.sortBy.enum = ["relevance", "score"];
    }, /find_agent input\.sortBy: no longer accepts "evidence", "confidence", "newest"/],
    ["a tighter input bound", (h) => void (findInput(h).properties.limit.maximum = 10), /find_agent input\.limit: maximum 50 → 10/],
    ["a removed output field", (h) => void delete findOutput(h).properties.coverage, /find_agent output\.coverage: removed/],
    ["an output field that may now be absent", (h) => {
      findOutput(h).required = findOutput(h).required.filter((name: string) => name !== "count");
    }, /find_agent output\.count: may now be absent/],
    ["an output field that may now be null", (h) => {
      const count = findOutput(h).properties.count;
      findOutput(h).properties.count = { anyOf: [count, { type: "null" }] };
    }, /find_agent output\.count: may now return null/],
    ["a new prompt argument that is required", (h) => {
      h.prompts.find((p: { name: string }) => p.name === "find-and-vet-agent").arguments.push({ name: "region", required: true });
    }, /prompt find-and-vet-agent: new required argument region/],
    ["a removed resource template", (h) => void h.resourceTemplates.pop(), /resource template stellar8004:\/\/owner\/\{address\}: removed/],
    ["a removed static resource", (h) => void h.resources.shift(), /resource stellar8004:\/\/health: removed/],
  ];

  it.each(cases)("fails on %s", (_label, edit, message) => {
    const { status, out } = compat(edit);
    expect(status).toBe(1);
    expect(out).toMatch(message);
    expect(out).toContain("::error title=Breaking MCP surface change::");
  });

  it("reports but passes a breaking change the PR accepts with --allow-breaking", () => {
    const { status, out } = compat((h) => void delete findOutput(h).properties.coverage, { flags: ["--allow-breaking"] });
    expect(status).toBe(0);
    expect(out).toMatch(/find_agent output\.coverage: removed/);
    expect(out).toContain("accepted by the `breaking-change` label");
  });

  it("exits 2 without two readable snapshots", () => {
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(process.execPath, [SCRIPT, join(DIR, "missing.json"), join(DIR, "missing.json")]).status).toBe(2);
  });
});
