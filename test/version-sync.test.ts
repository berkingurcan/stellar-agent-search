/** Runtime MCP package/version invariants for the split v2 client/server SDK. */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const PKG = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
};

/** The split v2 packages are exact pins by design. */
const SERVER_VERSION = PKG.dependencies["@modelcontextprotocol/server"];
const CLIENT_VERSION = PKG.dependencies["@modelcontextprotocol/client"];

describe("advertised MCP v2 runtime matches the shipped dependencies", () => {
  it("pins both split packages to the same exact version", () => {
    expect(SERVER_VERSION, "expected an exact server pin like 2.0.0").toMatch(/^\d+\.\d+\.\d+$/);
    expect(CLIENT_VERSION, "expected an exact client pin like 2.0.0").toMatch(/^\d+\.\d+\.\d+$/);
    expect(CLIENT_VERSION).toBe(SERVER_VERSION);
  });

  it("the CLI doctor banner advertises the server package actually used", () => {
    expect(read("src", "cli", "index.ts")).toContain(
      `@modelcontextprotocol/server ${SERVER_VERSION}`,
    );
  });

  it("runtime TypeScript has no imports from the v1 monolithic SDK", () => {
    const roots = [["src"], ["examples"]];
    const walk = (parts: string[]): string[] => {
      const dir = join(ROOT, ...parts);
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk([...parts, entry.name])
          : entry.name.endsWith(".ts")
            ? [read(...parts, entry.name)]
            : [],
      );
    };
    expect(roots.flatMap(walk).join("\n")).not.toContain("@modelcontextprotocol/sdk/");
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

  it("the tag workflow gates mismatched versions and can resume after npm publish", () => {
    const workflow = read(".github", "workflows", "publish.yml");
    expect(workflow).toContain('"$GITHUB_REF_NAME" != "v${package_version}"');
    expect(workflow).toContain("id: npm-version");
    expect(workflow).toContain("if: steps.npm-version.outputs.exists != 'true'");
  });

  it("the advertised spec date is the SDK's own latest protocol version", () => {
    expect(read("src", "cli", "index.ts")).toContain(`spec ${LATEST_PROTOCOL_VERSION}`);
  });
});
