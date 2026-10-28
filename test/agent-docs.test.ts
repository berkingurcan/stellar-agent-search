/**
 * agent-docs.test.ts — keep the AI-agent entry points (AGENTS.md, llms.txt) from rotting.
 *
 * An agent that lands on the repo follows these links literally. A renamed doc
 * would send it to a 404 with no release step in between, and the copy served
 * by the landing site must not drift from the one in the repo.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const REPO_BLOB = "https://github.com/berkingurcan/stellar-agent-search/blob/main/";

describe("AI-agent entry points", () => {
  it("web/static/llms.txt is an exact copy of llms.txt", () => {
    expect(read("web", "static", "llms.txt")).toBe(read("llms.txt"));
  });

  it("every llms.txt repo link points at a file that exists", () => {
    const paths = [...read("llms.txt").matchAll(/\]\((https:[^)]+)\)/g)]
      .map((m) => m[1])
      .filter((url) => url.startsWith(REPO_BLOB))
      .map((url) => url.slice(REPO_BLOB.length));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(existsSync(join(ROOT, p)), p).toBe(true);
  });

  it("every relative AGENTS.md link points at a file that exists", () => {
    const paths = [...read("AGENTS.md").matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)]
      .map((m) => m[1])
      .filter((p) => !/^[a-z]+:/.test(p));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(existsSync(join(ROOT, p)), p).toBe(true);
  });

  it("CLAUDE.md and GEMINI.md import AGENTS.md instead of duplicating it", () => {
    expect(read("CLAUDE.md").trim()).toBe("@AGENTS.md");
    expect(read("GEMINI.md").trim()).toBe("@AGENTS.md");
  });
});
