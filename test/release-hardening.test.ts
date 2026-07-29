import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATOR = join(ROOT, "scripts", "release", "create-bootstrap-package.mjs");

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
  });

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
