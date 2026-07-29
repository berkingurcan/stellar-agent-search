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
const serverPackage = server.packages?.[0];

check(pkg.engines?.node === ">=20", "package.json must require Node >=20");
check(
  pkg.bin?.["stellar-agent-mcp"] === "dist/index.js" && Object.keys(pkg.bin).length === 1,
  "package.json must expose exactly the stellar-agent-mcp CLI bin",
);
for (const field of ["main", "module", "types", "typings", "exports"]) {
  check(!(field in pkg), `package.json is bin-only and must not declare ${field}`);
}
check(pkg.files?.includes("dist"), "the npm tarball must include dist/");
check(pkg.mcpName === server.name, "package.json mcpName must match server.json name");
check(pkg.version === server.version, "package.json and server.json versions must match");
check(serverPackage?.identifier === pkg.name, "server.json must reference this npm package");
check(serverPackage?.version === pkg.version, "server.json package version must match package.json");
check(serverPackage?.registryType === "npm", "server.json package must use the npm registry");
check(serverPackage?.transport?.type === "stdio", "server.json package transport must be stdio");
check(
  typeof server.description === "string" && [...server.description].length <= 100,
  "server.json description must be 1-100 characters",
);

const expectedRuntime = `stellar-agent-mcp@${pkg.version}`;
const smithery = read("smithery.yaml");
check(
  smithery.includes(`args: ["-y", "${expectedRuntime}", "mcp"]`),
  `smithery.yaml must persist the exact ${expectedRuntime} mcp launch`,
);
check(
  !smithery.includes('args: ["-y", "stellar-agent-mcp"]'),
  "smithery.yaml must not execute the mutable npm latest tag",
);

const persistentDocs = [
  "README.md",
  "docs/getting-started.md",
  "docs/integration.md",
  "skills/mcp/SKILL.md",
];
for (const path of persistentDocs) {
  const contents = read(path);
  check(
    !contents.includes("-- npx -y stellar-agent-mcp mcp"),
    `${path} contains an unpinned persistent npx MCP launch`,
  );
  check(
    !contents.includes("npm i -g stellar-agent-mcp\n"),
    `${path} contains an unpinned persistent global install`,
  );
}

for (const path of ["CONTRIBUTING.md", "skills/mcp/SKILL.md"]) {
  check(!/Node(?:\.js)?\s*(?:≥|>=)\s*18/.test(read(path)), `${path} still advertises Node 18`);
}

const schemaPath = valueAfter("--schema");
if (schemaPath) {
  const schema = JSON.parse(readFileSync(resolve(schemaPath), "utf8"));
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
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
