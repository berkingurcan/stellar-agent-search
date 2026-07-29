import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(message) {
  process.stderr.write(`npm release verification: ${message}\n`);
  process.exit(1);
}

function option(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (required && (!value || value.startsWith("--"))) fail(`${name} is required`);
  return value;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    fail(`cannot parse ${path}: ${error.message}`);
  }
}

function normalizeRepository(value) {
  const url = typeof value === "string" ? value : value?.url;
  return String(url ?? "")
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git(?:#.*)?$/, "")
    .replace(/#.*$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function expectedIntegrity(tarballPath) {
  const digest = createHash("sha512").update(readFileSync(resolve(tarballPath))).digest("base64");
  return `sha512-${digest}`;
}

function verifyVersion(metadata, pkg, tarballPath, { requireTrustedPublisher }) {
  if (metadata?.name !== pkg.name || metadata?.version !== pkg.version) {
    fail(`registry metadata is not ${pkg.name}@${pkg.version}`);
  }
  if (normalizeRepository(metadata.repository) !== normalizeRepository(pkg.repository)) {
    fail(`published repository does not match ${normalizeRepository(pkg.repository)}`);
  }
  if (metadata.mcpName !== pkg.mcpName) fail("published mcpName does not match package.json");
  if (metadata.dist?.integrity !== expectedIntegrity(tarballPath)) {
    fail("published tarball integrity does not match the locally gated tarball");
  }
  let tarball;
  try {
    tarball = new URL(metadata.dist?.tarball);
  } catch {
    fail("published metadata has no valid tarball URL");
  }
  if (tarball.protocol !== "https:" || tarball.hostname !== "registry.npmjs.org") {
    fail("published tarball is not hosted on the canonical HTTPS npm registry");
  }
  if (requireTrustedPublisher) {
    const publisher = metadata._npmUser?.trustedPublisher;
    if (metadata._npmUser?.name !== "GitHub Actions" || publisher?.id !== "github") {
      fail("published version was not created by npm Trusted Publishing from GitHub Actions");
    }
  }
}

function decodeStatement(attestation) {
  try {
    return JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  } catch (error) {
    fail(`cannot decode attestation statement: ${error.message}`);
  }
}

const mode = process.argv[2];
const pkg = readJson(resolve(ROOT, "package.json"));
const tarballPath = option("--tarball");

if (mode === "preflight") {
  const packument = readJson(option("--packument"));
  const configuredOwners = option("--owners")
    .split(",")
    .map((owner) => owner.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (configuredOwners.length === 0) fail("--owners must list every authorized npm maintainer");

  const actualOwners = (packument.maintainers ?? [])
    .map((owner) => String(owner.name ?? "").toLowerCase())
    .filter(Boolean)
    .sort();
  if (JSON.stringify(actualOwners) !== JSON.stringify(configuredOwners)) {
    fail(
      `npm maintainers [${actualOwners.join(", ")}] do not exactly match the configured allowlist [${configuredOwners.join(", ")}]`,
    );
  }
  if (packument.name !== pkg.name) fail(`packument is not for ${pkg.name}`);

  const versions = Object.values(packument.versions ?? {});
  if (versions.length === 0) fail("the package exists but contains no published versions");
  for (const metadata of versions) {
    if (normalizeRepository(metadata.repository) !== normalizeRepository(pkg.repository)) {
      fail(`published ${metadata.version ?? "unknown version"} points at a different repository`);
    }
    if (metadata.mcpName !== pkg.mcpName) {
      fail(`published ${metadata.version ?? "unknown version"} has a different or missing mcpName`);
    }
  }

  const current = packument.versions?.[pkg.version];
  if (current) {
    verifyVersion(current, pkg, tarballPath, { requireTrustedPublisher: true });
  }
  process.stdout.write(`exists=${current ? "true" : "false"}\n`);
  process.exit(0);
}

if (mode === "published") {
  const metadata = readJson(option("--metadata"));
  const attestations = readJson(option("--attestations")).attestations ?? [];
  const expectedRepository = normalizeRepository(option("--repository"));
  const expectedWorkflow = option("--workflow");
  const expectedRef = option("--ref");
  const expectedCommit = option("--commit").toLowerCase();

  verifyVersion(metadata, pkg, tarballPath, { requireTrustedPublisher: true });

  const publish = attestations.find((item) =>
    item.predicateType?.includes("github.com/npm/attestation") && item.predicateType?.includes("/publish/"),
  );
  const provenance = attestations.find((item) => item.predicateType === "https://slsa.dev/provenance/v1");
  if (!publish || !provenance) fail("npm publish and SLSA provenance attestations are both required");

  const publishStatement = decodeStatement(publish);
  const provenanceStatement = decodeStatement(provenance);
  const digestHex = expectedIntegrity(tarballPath).slice("sha512-".length);
  const digestHexFromBase64 = Buffer.from(digestHex, "base64").toString("hex");
  for (const [label, statement] of [
    ["publish", publishStatement],
    ["provenance", provenanceStatement],
  ]) {
    if (!statement.subject?.some((subject) => subject.digest?.sha512 === digestHexFromBase64)) {
      fail(`${label} attestation does not cover the gated tarball digest`);
    }
  }
  if (
    publishStatement.predicate?.name !== pkg.name ||
    publishStatement.predicate?.version !== pkg.version ||
    publishStatement.predicate?.registry !== "https://registry.npmjs.org"
  ) {
    fail("npm publish attestation identifies a different package, version, or registry");
  }

  const predicate = provenanceStatement.predicate;
  const workflow = predicate?.buildDefinition?.externalParameters?.workflow;
  if (
    normalizeRepository(workflow?.repository) !== expectedRepository ||
    workflow?.path !== expectedWorkflow ||
    workflow?.ref !== expectedRef
  ) {
    fail("SLSA provenance source repository, workflow, or ref does not match this release");
  }
  const dependencies = predicate?.buildDefinition?.resolvedDependencies ?? [];
  if (!dependencies.some((item) => String(item.digest?.gitCommit ?? "").toLowerCase() === expectedCommit)) {
    fail("SLSA provenance does not resolve to the tagged release commit");
  }
  if (predicate?.runDetails?.builder?.id !== "https://github.com/actions/runner/github-hosted") {
    fail("SLSA provenance was not produced by a GitHub-hosted runner");
  }

  process.stdout.write("published npm artifact and provenance match the gated release\n");
  process.exit(0);
}

fail("mode must be preflight or published");
