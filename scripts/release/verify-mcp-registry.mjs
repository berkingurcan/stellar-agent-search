import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const responsePath = process.argv[2];

if (!responsePath) {
  process.stderr.write("MCP Registry verification: response JSON path is required\n");
  process.exit(1);
}

let expected;
let response;
try {
  expected = JSON.parse(readFileSync(resolve(ROOT, "server.json"), "utf8"));
  response = JSON.parse(readFileSync(resolve(responsePath), "utf8"));
} catch (error) {
  process.stderr.write(`MCP Registry verification: cannot parse metadata: ${error.message}\n`);
  process.exit(1);
}

/**
 * The registry stores server.json in a normalized form: schema-default fields
 * (observed: environmentVariables[].isRequired=false on the live 0.1.0 record)
 * are dropped before the object is re-served. Strip that default from both
 * sides so the exact-match gate compares meaning, not serialization accidents.
 */
function normalized(server) {
  const copy = JSON.parse(JSON.stringify(server));
  for (const pkg of copy.packages ?? []) {
    for (const variable of pkg.environmentVariables ?? []) {
      if (variable.isRequired === false) delete variable.isRequired;
    }
  }
  return copy;
}

if (!response.server || !isDeepStrictEqual(normalized(response.server), normalized(expected))) {
  process.stderr.write(
    "MCP Registry verification: the immutable registry version differs from local server.json\n",
  );
  process.exit(1);
}

process.stdout.write("MCP Registry version exactly matches server.json\n");
