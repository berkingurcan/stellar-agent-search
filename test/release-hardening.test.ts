import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATOR = join(ROOT, "scripts", "release", "create-bootstrap-package.mjs");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("npm bootstrap name reservation", () => {
  it("generates only an inert 0.0.0 package outside the repository", () => {
    const target = mkdtempSync(join(tmpdir(), "stellar-agent-bootstrap-"));
    const npmCache = mkdtempSync(join(tmpdir(), "stellar-agent-bootstrap-cache-"));
    try {
      const result = spawnSync(process.execPath, [GENERATOR, target], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(readdirSync(target).sort()).toEqual(["LICENSE", "README.md", "package.json"]);

      const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as Record<string, unknown>;
      expect(pkg.name).toBe("stellar-agent-mcp");
      expect(pkg.version).toBe("0.0.0");
      expect(pkg.mcpName).toBe("io.github.berkingurcan/stellar-agent-mcp");
      expect(pkg.publishConfig).toEqual({ access: "public", tag: "bootstrap" });
      for (const field of ["bin", "scripts", "dependencies", "devDependencies", "optionalDependencies"]) {
        expect(pkg, `${field} would make the reservation executable`).not.toHaveProperty(field);
      }

      const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: target,
        encoding: "utf8",
        env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
      });
      expect(packed.status, packed.stderr).toBe(0);
      const report = JSON.parse(packed.stdout) as Array<{
        id: string;
        entryCount: number;
        files: Array<{ path: string }>;
      }>;
      expect(report).toHaveLength(1);
      expect(report[0]?.id).toBe("stellar-agent-mcp@0.0.0");
      expect(report[0]?.entryCount).toBe(3);
      expect(report[0]?.files.map((file) => file.path).sort()).toEqual([
        "LICENSE",
        "README.md",
        "package.json",
      ]);
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(npmCache, { recursive: true, force: true });
    }
  }, 15_000);

  it("refuses repository paths and non-empty destinations", () => {
    const repositoryTarget = join(ROOT, `.bootstrap-test-${randomUUID()}`);
    const repositoryResult = spawnSync(process.execPath, [GENERATOR, repositoryTarget], {
      encoding: "utf8",
    });
    expect(repositoryResult.status).toBe(1);
    expect(repositoryResult.stderr).toContain("destination must be outside the repository");
    expect(existsSync(repositoryTarget)).toBe(false);

    const nonEmpty = mkdtempSync(join(tmpdir(), "stellar-agent-bootstrap-nonempty-"));
    try {
      writeFileSync(join(nonEmpty, "keep"), "user-owned\n");
      const result = spawnSync(process.execPath, [GENERATOR, nonEmpty], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("destination must be empty");
      expect(readFileSync(join(nonEmpty, "keep"), "utf8")).toBe("user-owned\n");
    } finally {
      rmSync(nonEmpty, { recursive: true, force: true });
    }
  });
});

describe("real release fail-closed gates", () => {
  it("advertises and enforces the x402 dependency chain's Node 22 runtime floor", () => {
    const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<string, { engines?: { node?: string } }>;
    };
    const ci = read(".github", "workflows", "ci.yml");

    expect(pkg.engines.node).toBe(">=22");
    expect(lock.packages[""]?.engines?.node).toBe(">=22");
    expect(read("scripts", "release", "validate-release.mjs")).toContain(
      'pkg.engines?.node === ">=22"',
    );
    expect(read("tsup.config.ts")).toContain('target: "node22"');
    expect(read("src", "cli", "index.ts")).toContain("major >= 22");
    expect(read("src", "cli", "setup.ts")).toContain("major >= 22");
    expect(ci).toContain("node: ['22', '24']");
    expect(ci).not.toContain("node: ['20'");
  });

  it("keeps the package bin-only and validates before any direct publish", () => {
    const pkg = JSON.parse(read("package.json")) as Record<string, unknown> & {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.prepublishOnly).toBe("npm run validate:release");
    expect(pkg.bin).toEqual({ "stellar-agent-mcp": "dist/index.js" });
    for (const field of ["main", "module", "types", "typings", "exports"]) {
      expect(pkg).not.toHaveProperty(field);
    }

    const server = JSON.parse(read("server.json")) as { description: string };
    const descriptionLength = [...server.description].length;
    expect(descriptionLength).toBeGreaterThan(0);
    expect(descriptionLength).toBeLessThanOrEqual(100);
  });

  it("protects OIDC publication and reuses the exact consumer-tested tarball", () => {
    const workflow = read(".github", "workflows", "publish.yml");
    expect(workflow).toContain("environment: npm-production");
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("NPM_PACKAGE_OWNERS");
    expect(workflow).toContain("verify-npm-release.mjs preflight");
    expect(workflow).toContain("verify-npm-release.mjs published");
    expect(workflow).toContain("npm pack --json --ignore-scripts --pack-destination");
    expect(workflow).toContain('npm install --ignore-scripts --no-audit --no-fund --save-exact "${{ steps.pack.outputs.path }}"');
    expect(workflow).toContain('npm install --ignore-scripts --no-audit --no-fund --save-exact "$package_name@$package_version"');
    expect(read(".github", "workflows", "ci.yml")).toContain("npm run check:release-surface");
    expect(workflow).toContain("npm sbom --omit=dev --sbom-format cyclonedx");
    expect(workflow).toContain('npm publish "${{ steps.pack.outputs.path }}" --ignore-scripts --access public');
    expect(workflow).toContain("/v0.1/servers/$encoded_name/versions/$encoded_version");
    expect(workflow).toContain("verify-mcp-registry.mjs");
  });

  it("documents the exact npm publisher filename, environment, and post-publish landing gate", () => {
    const runbook = read("instruction.md");
    expect(runbook).toContain("workflow filename: **`publish.yml`**");
    expect(runbook).toContain("environment name: **`npm-production`**");
    expect(runbook).toContain("`web/src/lib/install.ts`");
    expect(runbook).toContain("Never manually publish `0.1.0`");
    expect(runbook.indexOf("Reserve the npm name once")).toBeLessThan(
      runbook.indexOf("Make the canonical repository public"),
    );

    const landing = read("web", "src", "routes", "+page.svelte");
    const installSelector = read("web", "src", "lib", "install.ts");
    const pendingSurface = read("web", "src", "lib", "install-pending.ts");
    const webPackage = JSON.parse(read("web", "package.json")) as { scripts: Record<string, string> };
    expect(landing).not.toContain('code="npx -y stellar-agent-mcp@0.1.0');
    expect(landing).toContain("Install command withheld until the npm package");
    expect(installSelector).toContain("export * from './install-pending.js'");
    expect(pendingSurface).toContain("export const PACKAGE_PUBLISHED = false");
    expect(pendingSurface).not.toContain("npx");
    expect(webPackage.scripts.deploy).toContain("npm run check:release-surface");
  });
});
