import { copyFileSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const destinationArg = process.argv[2];

function fail(message) {
  process.stderr.write(`bootstrap package: ${message}\n`);
  process.exit(1);
}

if (!destinationArg) fail("pass an existing empty destination directory");

const destination = resolve(destinationArg);
if (destination === ROOT || destination.startsWith(`${ROOT}${sep}`)) {
  fail("destination must be outside the repository (use mktemp -d)");
}

try {
  if (!statSync(destination).isDirectory()) fail("destination is not a directory");
  if (readdirSync(destination).length !== 0) fail("destination must be empty");
} catch (error) {
  fail(`cannot inspect destination: ${error.message}`);
}

const source = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
if (source.name !== "stellar-agent-mcp") fail("unexpected source package name");
if (source.version === "0.0.0") fail("the source tree itself must never be the bootstrap version");
if (source.mcpName !== "io.github.berkingurcan/stellar-agent-mcp") {
  fail("unexpected MCP registry name");
}

const bootstrap = {
  name: source.name,
  version: "0.0.0",
  description: "Non-installable name reservation for the official stellar-agent-mcp package.",
  license: source.license,
  mcpName: source.mcpName,
  repository: source.repository,
  homepage: source.homepage,
  bugs: source.bugs,
  keywords: source.keywords,
  publishConfig: {
    access: "public",
    tag: "bootstrap",
  },
};

writeFileSync(resolve(destination, "package.json"), `${JSON.stringify(bootstrap, null, 2)}\n`, {
  flag: "wx",
});
writeFileSync(
  resolve(destination, "README.md"),
  "# stellar-agent-mcp bootstrap reservation\n\n" +
    "This package contains no executable code. Version 0.0.0 only reserves the npm name so the " +
    "official GitHub Actions Trusted Publisher can be configured. Install a provenance-backed " +
    "release version instead.\n",
  { flag: "wx" },
);
copyFileSync(resolve(ROOT, "LICENSE"), resolve(destination, "LICENSE"));

process.stdout.write(`${destination}\n`);
