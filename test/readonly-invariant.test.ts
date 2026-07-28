/**
 * readonly-invariant.test.ts — enforce non-negotiable #1: the server is
 * READ-ONLY and keyless. NO signer / write symbol may be reachable from src/.
 *
 * Two independent checks:
 *   1. Source import graph — no src/**.ts file imports or references any
 *      forbidden signer/write symbol from the SDK or stellar-sdk.
 *   2. Built bundle — the shipped dist/index.js names none of those symbols.
 *      NOTE: tsup externalizes runtime dependencies, so the SDK itself is NOT
 *      inlined here; this check therefore proves our *emitted* code never
 *      imports or references a signer, not that the dependency tree lacks one.
 *      (@trionlabs/stellar8004 does ship signers — we simply never reach for
 *      them.) Check 1 is what constrains the source; this one catches a symbol
 *      surviving compilation.
 *
 * `examples/x402-demo.ts` is explicitly allowed to sign and is NOT under src/,
 * so it is out of scope here (and not shipped in the bin bundle).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SRC = join(ROOT, "src");
const BIN = join(ROOT, "dist", "index.js");

/**
 * Signer / write / key symbols that must never be reachable. These are the
 * SDK's write surface (wrapBasicSigner/createClients/giveFeedback) and raw
 * keypair handling (Keypair from @stellar/stellar-sdk).
 */
const FORBIDDEN = ["wrapBasicSigner", "createClients", "giveFeedback", "Keypair"] as const;

/** Extra write-path method names that would betray a mutation attempt. */
const FORBIDDEN_WRITE_METHODS = ["give_feedback", "signAndSend", "signTransaction"] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("read-only invariant: source import graph", () => {
  const files = walk(SRC);

  it("has source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no src/**.ts references a forbidden signer/write/key symbol", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const sym of [...FORBIDDEN, ...FORBIDDEN_WRITE_METHODS]) {
        // Whole-word match so e.g. "createClients" isn't matched inside prose.
        const re = new RegExp(`\\b${sym}\\b`);
        if (re.test(text)) {
          offenders.push(`${file.replace(ROOT + "/", "")} → ${sym}`);
        }
      }
    }
    expect(offenders, `forbidden symbols found in source:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no src/**.ts imports a signer module or Keypair from stellar-sdk", () => {
    const badImports: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // Any import that names a signer or Keypair.
      if (/import[^;]*\b(wrapBasicSigner|FreighterSigner|WalletSigner|Keypair)\b/.test(text)) {
        badImports.push(file.replace(ROOT + "/", ""));
      }
      // Direct pull from the SDK signer subpath.
      if (/from\s+["']@trionlabs\/stellar8004\/signers/.test(text)) {
        badImports.push(file.replace(ROOT + "/", ""));
      }
    }
    expect(badImports).toEqual([]);
  });

  it("only reuses read clients (Explorer/Reputation), never the write client factory", () => {
    const joined = files.map((f) => readFileSync(f, "utf8")).join("\n");
    // Positive control: we DO use the read surface (guards against a broken scan).
    expect(joined).toMatch(/\bExplorerClient\b/);
    expect(joined).toMatch(/\bReputationClient\b/);
    // Negative: never the batch write-client factory.
    expect(joined).not.toMatch(/\bcreateClients\b/);
  });
});

describe("read-only invariant: shipped bundle", () => {
  beforeAll(() => {
    if (!existsSync(BIN)) {
      execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
    }
  }, 120_000);

  it("dist/index.js contains no forbidden signer/write/key symbol", () => {
    const bundle = readFileSync(BIN, "utf8");
    const present = FORBIDDEN.filter((sym) => new RegExp(`\\b${sym}\\b`).test(bundle));
    expect(present, `forbidden symbols leaked into the bundle: ${present.join(", ")}`).toEqual([]);
  });

  it("the read clients ARE bundled (proves the scan is meaningful)", () => {
    const bundle = readFileSync(BIN, "utf8");
    expect(bundle).toMatch(/ExplorerClient/);
    expect(bundle).toMatch(/ReputationClient/);
  });
});
