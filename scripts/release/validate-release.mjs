import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
}

function read(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function parseCanonicalGitHubRepository(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.replace(/^git\+/, "").replace(/\.git$/, ""));
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts.length !== 2 ||
      !/^[A-Za-z0-9-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9._-]+$/.test(parts[1])
    ) {
      return null;
    }
    const [owner, repository] = parts;
    return {
      owner,
      repository,
      slug: `${owner}/${repository}`,
      url: `https://github.com/${owner}/${repository}`,
      mcpName: `io.github.${owner}/${repository}`,
    };
  } catch {
    return null;
  }
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

const errors = [];
const check = (condition, message) => {
  if (!condition) errors.push(message);
};

const pkg = readJson("package.json");
const server = readJson("server.json");
const workerPkg = readJson("worker/package.json");
const serverPackage = server.packages?.[0];
const repositoryIdentity = parseCanonicalGitHubRepository(pkg.repository?.url);

check(pkg.engines?.node === ">=22", "package.json must require Node >=22");
check(
  pkg.devEngines?.runtime?.name === "node" &&
    pkg.devEngines.runtime.version === "^22.18.0 || >=24.11.0" &&
    pkg.devEngines.runtime.onFail === "error",
  "package.json must pin the contributor runtime to Node ^22.18.0 or >=24.11.0",
);
check(read(".node-version").trim() === "22.18.0", ".node-version must pin the minimum contributor runtime");
check(
  workerPkg.engines?.node === "^22.18.0 || >=24.11.0",
  "worker/package.json must use the contributor runtime range ^22.18.0 or >=24.11.0",
);
check(
  pkg.bin?.["stellar-agent-market"] === "dist/index.js" && Object.keys(pkg.bin).length === 1,
  "package.json must expose exactly the stellar-agent-market CLI bin",
);
for (const field of ["main", "module", "types", "typings", "exports"]) {
  check(!(field in pkg), `package.json is bin-only and must not declare ${field}`);
}
check(pkg.files?.includes("dist"), "the npm tarball must include dist/");
check(pkg.publishConfig?.access === "public", "the npm package must publish with public access");
check(
  pkg.scripts?.prepublishOnly === "npm run validate:release",
  "prepublishOnly must run the release metadata validator",
);
check(pkg.mcpName === server.name, "package.json mcpName must match server.json name");
check(pkg.version === server.version, "package.json and server.json versions must match");
check(serverPackage?.identifier === pkg.name, "server.json must reference this npm package");
check(serverPackage?.version === pkg.version, "server.json package version must match package.json");
check(serverPackage?.registryType === "npm", "server.json package must use the npm registry");
check(serverPackage?.transport?.type === "stdio", "server.json package transport must be stdio");
check(
  typeof server.description === "string" &&
    server.description.trim().length > 0 &&
    [...server.description].length <= 100,
  "server.json description must be 1-100 characters",
);

check(
  repositoryIdentity !== null,
  "package.json repository.url must be one canonical https://github.com/<owner>/<repository> identity",
);
if (repositoryIdentity) {
  check(
    pkg.mcpName === repositoryIdentity.mcpName,
    "package.json mcpName must derive from the canonical GitHub owner/repository",
  );
  check(
    server.repository?.source === "github" && server.repository.url === repositoryIdentity.url,
    "server.json repository must match the canonical package repository",
  );
  check(
    !server.websiteUrl?.startsWith("https://github.com/") || server.websiteUrl === repositoryIdentity.url,
    "a GitHub server.json websiteUrl must match the canonical package repository",
  );
  check(
    !pkg.homepage?.startsWith("https://github.com/") || pkg.homepage === `${repositoryIdentity.url}#readme`,
    "a GitHub package homepage must match the canonical package repository",
  );
  check(
    pkg.bugs?.url === `${repositoryIdentity.url}/issues`,
    "package.json bugs.url must match the canonical package repository",
  );
}

const publishWorkflow = read(".github/workflows/publish.yml");
check(
  publishWorkflow.includes("environment: npm-production"),
  ".github/workflows/publish.yml must use the npm-production protected environment",
);
const workflowRepository = publishWorkflow.match(/^\s*EXPECTED_REPOSITORY_URL:\s*(\S+)\s*$/m)?.[1];
if (repositoryIdentity) {
  check(
    workflowRepository === repositoryIdentity.url,
    ".github/workflows/publish.yml EXPECTED_REPOSITORY_URL must match package.json repository.url",
  );
  check(
    publishWorkflow.includes('[[ "$GITHUB_REPOSITORY" != "$repository_slug" ]]'),
    ".github/workflows/publish.yml must fail closed when the executing repository differs from package metadata",
  );

  const links = read("web/src/lib/links.ts");
  const landingRepository = links.match(/export const GITHUB = ['"]([^'"]+)['"];/)?.[1];
  check(
    landingRepository === repositoryIdentity.url,
    "web/src/lib/links.ts GITHUB must match the canonical package repository",
  );

  const identitySurfaces = [
    ["README.md", `npx skills add ${repositoryIdentity.slug} --skill mcp`],
    ["CONTRIBUTING.md", `git clone ${repositoryIdentity.url}`],
    ["CONTRIBUTING.md", `npx skills add ${repositoryIdentity.slug} --skill mcp`],
    ["SECURITY.md", `${repositoryIdentity.url}/security/advisories/new`],
    ["docs/getting-started.md", `npx skills add ${repositoryIdentity.slug} --skill mcp`],
    ["docs/recordings.md", `raw.githubusercontent.com/${repositoryIdentity.slug}/main/skills/mcp/SKILL.md`],
    ["docs/recordings.md", `npx skills add ${repositoryIdentity.slug} --skill mcp`],
    ["docs/evidence.md", repositoryIdentity.url],
    ["docs/evidence.md", `npx skills add ${repositoryIdentity.slug} --skill mcp`],
    ["skills/mcp/SKILL.md", `npx skills add ${repositoryIdentity.slug} --skill mcp`],
    ["skills/mcp/SKILL.md", `github.com/${repositoryIdentity.slug}`],
    ["web/src/lib/install-published.ts", `npx skills add ${repositoryIdentity.slug} --skill mcp`],
  ];
  for (const [path, expected] of identitySurfaces) {
    check(read(path).includes(expected), `${path} does not name the canonical repository identity`);
  }
}

const expectedRuntime = `${pkg.name}@${pkg.version}`;
const smithery = read("smithery.yaml");
check(
  smithery.includes(`args: ["-y", "${expectedRuntime}", "mcp"]`),
  `smithery.yaml must persist the exact ${expectedRuntime} mcp launch`,
);
check(
  !smithery.includes('args: ["-y", "stellar-agent-market"]'),
  "smithery.yaml must not execute the mutable npm latest tag",
);

const persistentDocs = [
  "README.md",
  "docs/getting-started.md",
  "docs/integration.md",
  "skills/mcp/SKILL.md",
  "web/src/lib/install-published.ts",
  "web/src/routes/+page.svelte",
];
for (const path of persistentDocs) {
  const contents = read(path);
  check(
    !/npx\s+(?:--yes|-y)\s+stellar-agent-market(?=[\s"'`]|$)/.test(contents),
    `${path} contains an unpinned persistent npx launch`,
  );
  check(
    !/npm\s+(?:i|install)\s+(?:-g\s+)?stellar-agent-market(?=[\s"'`]|$)/.test(contents),
    `${path} contains an unpinned persistent global install`,
  );
}

const publishedLanding = read("web/src/lib/install-published.ts");
check(
  publishedLanding.includes("packageMetadata.version") && !publishedLanding.includes("stellar-agent-market@0.1.0"),
  "published landing commands must derive their exact package pin from package.json.version",
);

for (const path of ["CONTRIBUTING.md", "skills/mcp/SKILL.md"]) {
  check(!/Node(?:\.js)?\s*(?:≥|>=)\s*18/.test(read(path)), `${path} still advertises Node 18`);
}

const schemaPath = valueAfter("--schema");
if (schemaPath) {
  const schema = JSON.parse(readFileSync(resolve(schemaPath), "utf8"));
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    // The official draft-07 document carries the non-validation `example`
    // annotation and composes one required field through `allOf`. Keep strict
    // type checking while accepting those two upstream schema conventions.
    strictSchema: false,
    strictRequired: false,
    formats: {
      uri(value) {
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      },
    },
  });
  const validate = ajv.compile(schema);
  if (!validate(server)) {
    for (const error of validate.errors ?? []) {
      errors.push(`server.json schema: ${error.instancePath || "/"} ${error.message}`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`release validation: ${error}\n`);
  process.exit(1);
}

process.stdout.write("release metadata is internally consistent\n");
