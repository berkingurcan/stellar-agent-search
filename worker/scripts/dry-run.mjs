import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertFetchOnlyBundle } from "./assert-fetch-bundle.mjs";

const workerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(workerRoot, ".wrangler-ci");
const result = spawnSync(
  "wrangler",
  ["deploy", "--dry-run", "--outdir", outdir],
  { cwd: workerRoot, encoding: "utf8" },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const files = await assertFetchOnlyBundle(outdir);
process.stdout.write(`Fetch-only bundle gate passed (${files.length} JavaScript file(s)).\n`);
