/**
 * version-sync.test.ts — the MCP SDK version we advertise must be the one we ship.
 *
 * The SDK version is written by hand in five places: the CLI's `doctor` banner,
 * the README badge, README prose, docs/architecture.md, and the sample doctor
 * output in docs/getting-started.md. Bumping the dependency without sweeping all
 * five leaves the product telling users a version it is not running — and the
 * `doctor` banner is the one a reviewer reads off the screen during a recording.
 *
 * This is not hypothetical: bumping 1.29.0 -> 1.30.0 to clear a CVE invalidated
 * all five in one step.
 *
 * The protocol version is checked against the SDK itself rather than a literal,
 * so `spec 2025-11-25` cannot outlive the SDK that defines it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const PKG = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
};

/** The exact version pinned for the SDK (the pin is exact by design). */
const SDK_VERSION = PKG.dependencies["@modelcontextprotocol/sdk"];

/** Every file that spells the SDK version out loud, and what it must contain. */
const SITES: Array<[string, string[], (v: string) => string]> = [
  ["CLI doctor banner", ["src", "cli", "index.ts"], (v) => `@modelcontextprotocol/sdk ${v}`],
  ["README badge", ["README.md"], (v) => `MCP-${v}-`],
  ["README prose", ["README.md"], (v) => `\`@modelcontextprotocol/sdk\` ${v}`],
  ["architecture.md", ["docs", "architecture.md"], (v) => `\`@modelcontextprotocol/sdk\` **${v}**`],
  ["getting-started sample", ["docs", "getting-started.md"], (v) => `@modelcontextprotocol/sdk ${v}`],
];

describe("advertised MCP SDK version matches the shipped dependency", () => {
  it("the pin is an exact version, not a range", () => {
    // A range would make "the version we advertise" unknowable at write time.
    expect(SDK_VERSION, "expected an exact pin like 1.30.0").toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const [label, path, expected] of SITES) {
    it(`${label} says ${SDK_VERSION}`, () => {
      const body = read(...path);
      expect(body, `${path.join("/")} does not advertise ${SDK_VERSION}`).toContain(
        expected(SDK_VERSION),
      );
    });
  }

  it("no file still advertises a different SDK version", () => {
    const stale: string[] = [];
    for (const [label, path] of SITES) {
      const body = read(...path);
      for (const m of body.matchAll(/@modelcontextprotocol\/sdk[`*\s]+(\d+\.\d+\.\d+)/g)) {
        if (m[1] !== SDK_VERSION) stale.push(`${label}: ${m[1]}`);
      }
      for (const m of body.matchAll(/MCP-(\d+\.\d+\.\d+)-/g)) {
        if (m[1] !== SDK_VERSION) stale.push(`${label} badge: ${m[1]}`);
      }
    }
    expect(stale, `stale SDK versions: ${stale.join(", ")}`).toEqual([]);
  });

  it("server.json's two version fields match package.json", () => {
    // CONTRIBUTING lists these as hand-maintained. publish.yml fires on a `v*`
    // tag and pushes both npm and the MCP Registry, so a bump that misses either
    // field advertises a version to the registry that npm never published.
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const server = JSON.parse(read("server.json")) as {
      version: string;
      packages: Array<{ version: string; identifier?: string }>;
    };
    expect(server.version, "server.json top-level version").toBe(pkg.version);
    for (const [i, p] of server.packages.entries()) {
      expect(p.version, `server.json packages[${i}].version`).toBe(pkg.version);
    }
  });

  it("the advertised spec date is the SDK's own latest protocol version", () => {
    for (const path of [
      ["src", "cli", "index.ts"],
      ["README.md"],
      ["docs", "architecture.md"],
      ["docs", "getting-started.md"],
    ]) {
      expect(read(...path), `${path.join("/")} must say spec ${LATEST_PROTOCOL_VERSION}`).toContain(
        LATEST_PROTOCOL_VERSION,
      );
    }
  });
});
