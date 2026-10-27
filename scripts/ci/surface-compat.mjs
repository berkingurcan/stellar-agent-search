/**
 * surface-compat.mjs — classify the difference between two MCP surface snapshots
 * (test/__surface__/mcp-surface.json) as breaking, additive or changed.
 *
 *   node scripts/ci/surface-compat.mjs <base.json> <head.json> [--allow-breaking]
 *
 * Breaking means a client written against the base surface can fail against the head one:
 *   - a tool, prompt, resource template or static resource is gone, or a resource's MIME type changed;
 *   - input it used to send is refused: a removed or newly required property or prompt argument,
 *     or a narrower type, enum, `anyOf` or bound;
 *   - output it used to read is gone or shaped differently: a removed property, a property that is
 *     no longer required, a new type or `anyOf` branch (such as null), or a new enum value.
 * Additive changes (a new tool, an optional input, an extra output field) and wording changes are
 * listed but never fail. Output bounds that move are listed as changed, not breaking.
 *
 * Exit 1 on a breaking change unless --allow-breaking (the PR carries the `breaking-change` label).
 * The report also goes to $GITHUB_STEP_SUMMARY when it is set.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const args = process.argv.slice(2);
const allowBreaking = args.includes("--allow-breaking");
const [basePath, headPath] = args.filter((arg) => !arg.startsWith("--"));

if (!basePath || !headPath) {
  process.stderr.write("usage: surface-compat.mjs <base.json> <head.json> [--allow-breaking]\n");
  process.exit(2);
}

let base;
let head;
try {
  base = JSON.parse(readFileSync(basePath, "utf8"));
  head = JSON.parse(readFileSync(headPath, "utf8"));
} catch (error) {
  process.stderr.write(`surface-compat: cannot read a snapshot: ${error.message}\n`);
  process.exit(2);
}

const breaking = [];
const additive = [];
const changed = [];

function byKey(list = [], key) {
  return new Map(list.map((item) => [item[key], item]));
}

function typesOf(schema) {
  return schema.type === undefined ? undefined : [].concat(schema.type);
}

function valuesOf(schema) {
  if (schema.const !== undefined) return [schema.const];
  return schema.enum;
}

/** A key that pairs an `anyOf` branch in one snapshot with the same branch in the other. */
function branchKey(schema) {
  if (schema.const !== undefined) return `const ${JSON.stringify(schema.const)}`;
  if (schema.type !== undefined) return [].concat(schema.type).join("|");
  return JSON.stringify(schema);
}

const show = (values) => values.map((value) => JSON.stringify(value)).join(", ");

const LOWER_BOUNDS = ["minimum", "exclusiveMinimum", "minLength", "minItems"];
const UPPER_BOUNDS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems"];
const HANDLED = new Set([
  "anyOf",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "pattern",
  ...LOWER_BOUNDS,
  ...UPPER_BOUNDS,
]);

/**
 * Compare two JSON Schemas. `side` is "input" (the client sends it, so the head must accept
 * everything the base accepted) or "output" (the client reads it, so the head must not return
 * anything the base did not promise).
 */
function compareSchema(a, b, path, side) {
  if (isDeepStrictEqual(a, b)) return;
  const input = side === "input";

  if (a.anyOf || b.anyOf) {
    const aBranches = new Map((a.anyOf ?? [a]).map((s) => [branchKey(s), s]));
    const bBranches = new Map((b.anyOf ?? [b]).map((s) => [branchKey(s), s]));
    for (const [key, branch] of aBranches) {
      if (bBranches.has(key)) compareSchema(branch, bBranches.get(key), `${path}<${key}>`, side);
      else if (input) breaking.push(`${path}: no longer accepts ${key}`);
      else changed.push(`${path}: no longer returns ${key}`);
    }
    for (const key of bBranches.keys()) {
      if (aBranches.has(key)) continue;
      if (input) additive.push(`${path}: now also accepts ${key}`);
      else breaking.push(`${path}: may now return ${key}`);
    }
    const rest = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !HANDLED.has(k)));
    if (a.anyOf && b.anyOf && !isDeepStrictEqual(rest(a), rest(b))) changed.push(`${path}: annotations changed`);
    return;
  }

  const aTypes = typesOf(a);
  const bTypes = typesOf(b);
  if (aTypes && bTypes && !isDeepStrictEqual(aTypes, bTypes)) {
    const lost = aTypes.filter((t) => !bTypes.includes(t));
    const gained = bTypes.filter((t) => !aTypes.includes(t));
    if (input && lost.length) breaking.push(`${path}: no longer accepts type ${lost.join(", ")}`);
    if (input && gained.length) additive.push(`${path}: now also accepts type ${gained.join(", ")}`);
    if (!input && gained.length) breaking.push(`${path}: may now be type ${gained.join(", ")}`);
    if (!input && lost.length) changed.push(`${path}: no longer type ${lost.join(", ")}`);
  }

  const aValues = valuesOf(a);
  const bValues = valuesOf(b);
  if (!isDeepStrictEqual(aValues, bValues)) {
    if (aValues && bValues) {
      const lost = aValues.filter((v) => !bValues.some((w) => isDeepStrictEqual(v, w)));
      const gained = bValues.filter((v) => !aValues.some((w) => isDeepStrictEqual(v, w)));
      if (input && lost.length) breaking.push(`${path}: no longer accepts ${show(lost)}`);
      if (input && gained.length) additive.push(`${path}: now also accepts ${show(gained)}`);
      if (!input && gained.length) breaking.push(`${path}: may now return ${show(gained)}`);
      if (!input && lost.length) changed.push(`${path}: no longer returns ${show(lost)}`);
    } else if (aValues) {
      (input ? additive : breaking).push(`${path}: no longer limited to ${show(aValues)}`);
    } else {
      (input ? breaking : changed).push(`${path}: now limited to ${show(bValues)}`);
    }
  }

  for (const keyword of [...LOWER_BOUNDS, ...UPPER_BOUNDS]) {
    if (a[keyword] === b[keyword]) continue;
    const lower = LOWER_BOUNDS.includes(keyword);
    const tightened =
      b[keyword] !== undefined &&
      (a[keyword] === undefined || (lower ? b[keyword] > a[keyword] : b[keyword] < a[keyword]));
    const line = `${path}: ${keyword} ${a[keyword] ?? "none"} → ${b[keyword] ?? "none"}`;
    if (!input) changed.push(line);
    else (tightened ? breaking : additive).push(line);
  }

  if (a.pattern !== b.pattern) (input ? breaking : changed).push(`${path}: pattern changed`);

  if (a.properties || b.properties) {
    const aProps = a.properties ?? {};
    const bProps = b.properties ?? {};
    const aRequired = new Set(a.required ?? []);
    const bRequired = new Set(b.required ?? []);
    for (const [name, schema] of Object.entries(aProps)) {
      const at = `${path}.${name}`;
      if (!(name in bProps)) {
        breaking.push(input ? `${at}: removed (callers that send it are refused or ignored)` : `${at}: removed`);
        continue;
      }
      compareSchema(schema, bProps[name], at, side);
      if (input && !aRequired.has(name) && bRequired.has(name)) breaking.push(`${at}: now required`);
      if (input && aRequired.has(name) && !bRequired.has(name)) additive.push(`${at}: now optional`);
      if (!input && aRequired.has(name) && !bRequired.has(name)) breaking.push(`${at}: may now be absent`);
      if (!input && !aRequired.has(name) && bRequired.has(name)) additive.push(`${at}: now always present`);
    }
    for (const name of Object.keys(bProps)) {
      if (name in aProps) continue;
      const at = `${path}.${name}`;
      if (input && bRequired.has(name)) breaking.push(`${at}: new required property`);
      else additive.push(`${at}: new ${input || !bRequired.has(name) ? "optional " : ""}property`);
    }
  }

  if (!isDeepStrictEqual(a.additionalProperties, b.additionalProperties)) {
    const closes = a.additionalProperties !== false && b.additionalProperties === false;
    const opens = a.additionalProperties === false && b.additionalProperties !== false;
    if (input && closes) breaking.push(`${path}: unknown properties are now refused`);
    else if (input && opens) additive.push(`${path}: unknown properties are now accepted`);
    else if (typeof a.additionalProperties === "object" && typeof b.additionalProperties === "object") {
      compareSchema(a.additionalProperties, b.additionalProperties, `${path}{*}`, side);
    } else changed.push(`${path}: additionalProperties changed`);
  }

  if (a.items && b.items) compareSchema(a.items, b.items, `${path}[]`, side);
  else if (a.items || b.items) changed.push(`${path}: items changed`);

  const annotations = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !HANDLED.has(k)));
  const differing = [...annotations].filter((k) => !isDeepStrictEqual(a[k], b[k]));
  if (differing.length) changed.push(`${path}: ${differing.join(", ")} changed`);
}

function compareNamed(kind, baseList, headList, key, compare) {
  const before = byKey(baseList, key);
  const after = byKey(headList, key);
  for (const [name, item] of before) {
    if (!after.has(name)) breaking.push(`${kind} ${name}: removed`);
    else compare(name, item, after.get(name));
  }
  for (const name of after.keys()) {
    if (!before.has(name)) additive.push(`${kind} ${name}: added`);
  }
}

function compareAnnotations(label, a, b, keys) {
  const differing = keys.filter((k) => !isDeepStrictEqual(a[k], b[k]));
  if (differing.length) changed.push(`${label}: ${differing.join(", ")} changed`);
}

for (const mode of new Set([...Object.keys(base.instructions ?? {}), ...Object.keys(head.instructions ?? {})])) {
  if (base.instructions?.[mode] !== head.instructions?.[mode]) changed.push(`instructions (${mode}) changed`);
}

compareNamed("tool", base.tools, head.tools, "name", (name, a, b) => {
  compareSchema(a.inputSchema ?? {}, b.inputSchema ?? {}, `${name} input`, "input");
  if (a.outputSchema && !b.outputSchema) breaking.push(`${name} output: schema removed`);
  else if (!a.outputSchema && b.outputSchema) additive.push(`${name} output: schema added`);
  else if (a.outputSchema) compareSchema(a.outputSchema, b.outputSchema, `${name} output`, "output");
  compareAnnotations(`tool ${name}`, a, b, ["title", "description", "annotations"]);
});

compareNamed("prompt", base.prompts, head.prompts, "name", (name, a, b) => {
  const before = byKey(a.arguments, "name");
  const after = byKey(b.arguments, "name");
  for (const [arg, spec] of before) {
    if (!after.has(arg)) breaking.push(`prompt ${name}: argument ${arg} removed`);
    else if (!spec.required && after.get(arg).required) breaking.push(`prompt ${name}: argument ${arg} now required`);
    else compareAnnotations(`prompt ${name} argument ${arg}`, spec, after.get(arg), ["description", "required"]);
  }
  for (const [arg, spec] of after) {
    if (before.has(arg)) continue;
    if (spec.required) breaking.push(`prompt ${name}: new required argument ${arg}`);
    else additive.push(`prompt ${name}: new optional argument ${arg}`);
  }
  compareAnnotations(`prompt ${name}`, a, b, ["title", "description"]);
});

const compareResource = (kind) => (name, a, b) => {
  if (a.mimeType !== b.mimeType) breaking.push(`${kind} ${name}: mimeType ${a.mimeType} → ${b.mimeType}`);
  compareAnnotations(`${kind} ${name}`, a, b, ["name", "title", "description", "annotations"]);
};
compareNamed("resource template", base.resourceTemplates, head.resourceTemplates, "uriTemplate", compareResource("resource template"));
compareNamed("resource", base.resources, head.resources, "uri", compareResource("resource"));

const sections = [
  ["Breaking", breaking],
  ["Additive", additive],
  ["Changed (wording, annotations, output bounds)", changed],
];
const verdict = breaking.length === 0
  ? "No breaking change to the MCP surface."
  : allowBreaking
    ? `${breaking.length} breaking change(s), accepted by the \`breaking-change\` label.`
    : `${breaking.length} breaking change(s). If this is deliberate, label the PR \`breaking-change\` and note it in CHANGELOG.md.`;

let report = "";
for (const [title, lines] of sections) {
  if (lines.length) report += `\n${title} (${lines.length}):\n${lines.map((line) => `  - ${line}`).join("\n")}\n`;
}
process.stdout.write(`${breaking.length + additive.length + changed.length === 0 ? "No changes to the MCP surface.\n" : report}\n${verdict}\n`);

if (process.env.GITHUB_STEP_SUMMARY) {
  let summary = `## MCP surface compatibility\n\n${verdict}\n`;
  for (const [title, lines] of sections) {
    if (lines.length) summary += `\n### ${title}\n\n${lines.map((line) => `- \`${line.replaceAll("`", "'")}\``).join("\n")}\n`;
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (breaking.length && !allowBreaking) {
  for (const line of breaking) process.stdout.write(`::error title=Breaking MCP surface change::${line}\n`);
  process.exit(1);
}
