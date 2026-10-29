/**
 * provider-standard.ts — Provider Standard v1 (`stellar-agent-services/provider@1`),
 * the part a discovery client needs: find the manifest an agent's registration
 * names, and read it into typed values that are safe to show.
 *
 * The standard is docs/provider-standard.md in Stellar Agent Services; every
 * check here cites its rule ids ([M3], [P1], [I1]…). Its reference package is not
 * on npm yet, so the few constants needed here are copies, and
 * test/provider-standard.test.ts runs this reader over the standard's own
 * manifest test vectors (test/fixtures/provider-standard/manifests.json).
 *
 * This is a structural read for display, not the verifier's C1. It does not run
 * the manifest JSON Schema over service schemas: their contents ([S5]), sizes
 * ([S6]) and examples ([S9]) are left to the verifier and the payment client. It
 * checks every field it returns, and refuses a manifest whose payment terms it
 * cannot read exactly: a price, payee, asset or network shown to a user is the
 * one the manifest states, or none at all. Conformance evidence comes from a
 * trusted verifier's Validation Registry record (validation.ts).
 *
 * Text the provider chose (names, descriptions, titles, tags, URLs) is returned
 * raw under `text` for the caller to sanitize into a selfDeclared slot. Problem
 * messages are server-authored and never quote it.
 */

import { validWalletOrNull } from "./identifier.js";
import type { Network, ServiceEntry } from "../types.js";

/** The manifest's `standard`. Another major version is rejected [M8]. */
export const PROVIDER_STANDARD = "stellar-agent-services/provider@1";

/** The registration `services` entry that names the manifest [I1]. */
export const MANIFEST_SERVICE_NAME = "stellar-agent-services";
export const MANIFEST_SERVICE_VERSION = "1";

/** Largest manifest a client reads [M3]. */
export const MANIFEST_MAX_BYTES = 256 * 1024;

/** Longest URL a manifest may hold [M6]. */
export const MAX_MANIFEST_URL_LENGTH = 300;

/** CAIP-2 ids of the networks the standard supports (§4.1). */
export type StellarNetwork = "stellar:testnet" | "stellar:pubnet";

/**
 * The USDC Stellar Asset Contract on each network, the only asset in v1 (§4.1).
 * Copies of @x402/stellar's USDC_TESTNET_ADDRESS and USDC_PUBNET_ADDRESS, which
 * test/provider-standard.test.ts pins.
 */
export const USDC_ASSET: Readonly<Record<StellarNetwork, string>> = {
  "stellar:testnet": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "stellar:pubnet": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
};

/** USDC base units per whole USDC: 7 decimals, so "100000" is 0.01 USDC (§3.1). */
export const USDC_DECIMALS = 7;

/** How long results stay retrievable when the manifest sets no `jobs.retentionSeconds` [J15]. */
export const DEFAULT_RETENTION_SECONDS = 86_400;
const MIN_RETENTION_SECONDS = 3_600;
const DEFAULT_MAX_INPUT_BYTES = 1_048_576;
const MAX_INPUT_BYTES = 10 * 1_048_576;
const MAX_SERVICES = 25;
const MAX_EXAMPLES = 5;
const MAX_TAGS = 10;
const MAX_U32 = 0xffff_ffff;

const SERVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A positive integer of at most 38 digits, in base units (§3.1). */
const PRICE_AMOUNT = /^[1-9][0-9]{0,37}$/;
const TAG = /^[a-z0-9-]{1,32}$/;
/** Text without control characters (the schema's `line`). */
const LINE = /^[^\u0000-\u001f]*$/;
/** Text that may hold tabs and newlines but no other control character (the schema's `text`). */
const TEXT = /^[^\u0000-\u0008\u000b-\u001f]*$/;
const STANDARD_ID = /^stellar-agent-services\/provider@\d+$/;

/** The CAIP-2 id of this server's network. */
export function caip2Network(network: Network): StellarNetwork {
  return network === "mainnet" ? "stellar:pubnet" : "stellar:testnet";
}

/** A rule the manifest breaks: its id in the standard when it has one, in the server's own words. */
export interface ManifestProblem {
  rule?: string;
  message: string;
}

/** The manifest's one payment option [P1], with every field checked. */
export interface ManifestPayment {
  protocol: "x402";
  x402Version: 2;
  scheme: "exact";
  network: StellarNetwork;
  /** The USDC Stellar Asset Contract for `network`. */
  asset: string;
  /** A G… or C… address with a valid checksum [P11]. */
  payTo: string;
  maxTimeoutSeconds: number;
  /** `extra.areFeesSponsored`: the payer needs only USDC. */
  feesSponsored: true;
}

export interface ManifestPrice {
  /** Base units, exactly as the manifest states them. */
  amount: string;
  asset: "USDC";
  decimals: typeof USDC_DECIMALS;
  /** The same amount in whole USDC, e.g. "0.01". */
  usdc: string;
}

export interface ManifestService {
  /** Matches `^[a-z0-9][a-z0-9_-]{0,63}$`: a token, safe to use as an identifier. */
  name: string;
  price: ManifestPrice;
  charge: "on-success" | "upfront";
  expectedDurationSeconds: number | null;
  maxInputBytes: number;
  capacity: { concurrency: number | null; maxQueueWaitSeconds: number | null } | null;
  /** Provider-chosen text: sanitize it, and label it as provider-supplied (§10). */
  text: { title: string | null; description: string; tags: string[] };
}

export interface ProviderManifestView {
  /** `provider.agentId`, needed for the identity check [I2]. */
  agentId: number | null;
  payment: ManifestPayment;
  retentionSeconds: number;
  /** True when the manifest leaves `jobs.retentionSeconds` to its default. */
  retentionDefaulted: boolean;
  services: ManifestService[];
  dataUse: { storesInputs: boolean | null; trainsOnInputs: boolean | null };
  /** Provider-chosen text and URLs: sanitize before showing. */
  text: {
    name: string;
    description: string | null;
    homepage: string | null;
    termsUrl: string | null;
    baseUrl: string;
  };
}

export type ManifestReadResult =
  | { ok: true; manifest: ProviderManifestView }
  | { ok: false; problems: ManifestProblem[] };

/** Where a registration says its Provider Standard manifest is [I1]. */
export type ManifestDeclaration =
  | { kind: "declared"; url: string }
  | { kind: "absent" }
  | { kind: "invalid"; problem: ManifestProblem };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * The manifest a registration's services name: the entry
 * `{ name: "stellar-agent-services", endpoint: <manifest URL>, version: "1" }`
 * [I1]. Two different URLs are refused rather than one picked: the caller would
 * not know which provider it is about to pay.
 */
export function findManifestDeclaration(services: readonly ServiceEntry[] | null | undefined): ManifestDeclaration {
  const entries = (services ?? []).filter((s) => s.name === MANIFEST_SERVICE_NAME);
  if (entries.length === 0) return { kind: "absent" };
  const current = entries.filter((s) => s.version === MANIFEST_SERVICE_VERSION);
  if (current.length === 0) {
    return {
      kind: "invalid",
      problem: { rule: "I1", message: 'the registration lists the manifest without version "1"' },
    };
  }
  const urls = new Set(current.map((s) => s.endpoint));
  if (urls.size > 1) {
    return {
      kind: "invalid",
      problem: { rule: "I1", message: `the registration lists ${urls.size} different manifest URLs` },
    };
  }
  return { kind: "declared", url: current[0]!.endpoint };
}

/** Base units as whole USDC: "100000" → "0.01", "12340000000" → "1234". */
export function formatUsdc(amount: string): string {
  const digits = amount.padStart(USDC_DECIMALS + 1, "0");
  const whole = digits.slice(0, -USDC_DECIMALS).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-USDC_DECIMALS).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Parse manifest text the way a client must [M3]: JSON, I-JSON (no duplicate
 * keys, no lone surrogates), then the field rules. `manifestUrl` is where it
 * was fetched from, for [M1] and [M5].
 */
export function parseManifestText(text: string, manifestUrl: string): ManifestReadResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse("M3", "the manifest is not JSON");
  }
  // JSON.parse keeps the last of two equal keys and another parser may keep the
  // first, so two clients could show different payees for one manifest.
  if (hasDuplicateKey(text)) return refuse("M3", "the manifest repeats a key in one object (I-JSON)");
  if (hasLoneSurrogate(value)) return refuse("M3", "the manifest holds a lone surrogate (I-JSON)");
  return readManifest(value, manifestUrl);
}

/** The field rules over an already parsed manifest. */
export function readManifest(value: unknown, manifestUrl: string): ManifestReadResult {
  if (!isRecord(value)) return refuse("M9", "the manifest is not a JSON object");
  if (typeof value.standard !== "string") return refuse("M9", "standard is missing");
  if (value.standard !== PROVIDER_STANDARD) {
    return STANDARD_ID.test(value.standard)
      ? refuse("M8", "the manifest uses another major version of the standard")
      : refuse("M9", `standard is not ${PROVIDER_STANDARD}`);
  }

  const problems: ManifestProblem[] = [];
  const report = (rule: string | undefined, message: string): void => {
    problems.push(rule === undefined ? { message } : { rule, message });
  };

  const origin = manifestUrl.startsWith("https://") ? originOf(manifestUrl) : undefined;
  if (origin === undefined) report("M1", "the manifest must be served over HTTPS");

  const provider = isRecord(value.provider) ? value.provider : undefined;
  if (provider === undefined) report("M9", "provider is missing");
  const name = line(provider?.name, 1, 120);
  if (provider !== undefined && name === undefined) {
    report("M9", "provider.name must be 1–120 characters without control characters");
  }
  const description = optional(provider?.description, (v) => text(v, 0, 500));
  if (description === INVALID) report("M9", "provider.description must be at most 500 characters of text");
  const homepage = optional(provider?.homepage, httpsUrl);
  if (homepage === INVALID) report("M6", "provider.homepage must be an HTTPS URL of at most 300 characters");
  const termsUrl = optional(provider?.termsUrl, httpsUrl);
  if (termsUrl === INVALID) report("M6", "provider.termsUrl must be an HTTPS URL of at most 300 characters");
  const agentId = optional(provider?.agentId, (v) => (isInteger(v, 0, MAX_U32) ? v : undefined));
  if (agentId === INVALID) report("M9", "provider.agentId must be a Stellar 8004 agent id (u32)");
  const dataUse = isRecord(provider?.dataUse) ? provider.dataUse : undefined;
  if (provider?.dataUse !== undefined && dataUse === undefined) report("M9", "provider.dataUse must be an object");
  const storesInputs = optional(dataUse?.storesInputs, boolean);
  const trainsOnInputs = optional(dataUse?.trainsOnInputs, boolean);
  if (storesInputs === INVALID || trainsOnInputs === INVALID) {
    report("M9", "provider.dataUse fields must be booleans");
  }

  const baseUrl = readBaseUrl(value.baseUrl);
  if (baseUrl === undefined) {
    report("M5", "baseUrl must be HTTPS, with no user info, query, fragment, empty segment or trailing slash");
  } else if (origin !== undefined && originOf(baseUrl) !== origin) {
    report("M5", "baseUrl must have the same origin as the manifest URL");
  }

  const payment = readPayment(value.payment, report);

  let retentionSeconds = DEFAULT_RETENTION_SECONDS;
  let retentionDefaulted = true;
  if (value.jobs !== undefined) {
    if (!isRecord(value.jobs)) report("M9", "jobs must be an object");
    else if (value.jobs.retentionSeconds !== undefined) {
      if (isInteger(value.jobs.retentionSeconds, MIN_RETENTION_SECONDS, Number.MAX_SAFE_INTEGER)) {
        retentionSeconds = value.jobs.retentionSeconds;
        retentionDefaulted = false;
      } else {
        report("M9", `jobs.retentionSeconds must be an integer of at least ${MIN_RETENTION_SECONDS}`);
      }
    }
  }

  const services = readServices(value.services, report);
  if (value.extensions !== undefined && !isRecord(value.extensions)) report("M9", "extensions must be an object");

  if (problems.length > 0 || name === undefined || baseUrl === undefined || payment === undefined || !services) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    manifest: {
      agentId: valueOrNull(agentId),
      payment,
      retentionSeconds,
      retentionDefaulted,
      services,
      dataUse: { storesInputs: valueOrNull(storesInputs), trainsOnInputs: valueOrNull(trainsOnInputs) },
      text: {
        name,
        description: valueOrNull(description),
        homepage: valueOrNull(homepage),
        termsUrl: valueOrNull(termsUrl),
        baseUrl,
      },
    },
  };
}

type Report = (rule: string | undefined, message: string) => void;

function readPayment(value: unknown, report: Report): ManifestPayment | undefined {
  if (!isRecord(value)) {
    report("M9", "payment is missing");
    return undefined;
  }
  let ok = true;
  const fail = (rule: string, message: string): void => {
    report(rule, message);
    ok = false;
  };
  if (value.protocol !== "x402") fail("M9", 'payment.protocol must be "x402"');
  if (value.x402Version !== 2) fail("M9", "payment.x402Version must be 2");
  const accepts = value.accepts;
  if (!Array.isArray(accepts) || accepts.length !== 1) {
    fail("P1", "payment.accepts must have exactly one entry");
    return undefined;
  }
  const option: unknown = accepts[0];
  if (!isRecord(option)) {
    fail("M9", "the payment option must be an object");
    return undefined;
  }
  if (option.amount !== undefined) fail("P1", "the payment option must not include amount");
  if (option.scheme !== "exact") fail("M9", 'the payment scheme must be "exact"');
  const network =
    option.network === "stellar:testnet" || option.network === "stellar:pubnet" ? option.network : undefined;
  if (network === undefined) fail("M9", "the payment network must be stellar:testnet or stellar:pubnet");
  else if (option.asset !== USDC_ASSET[network]) {
    fail("M9", `the payment asset must be the USDC Stellar Asset Contract for ${network}`);
  }
  // A muxed (M…) or malformed address never reads as valid here.
  const payTo = typeof option.payTo === "string" ? validWalletOrNull(option.payTo) : null;
  if (payTo === null || payTo !== option.payTo) {
    fail("P11", "payTo must be a G… or C… address with a valid checksum");
  }
  if (!isInteger(option.maxTimeoutSeconds, 30, 300)) fail("M9", "maxTimeoutSeconds must be an integer from 30 to 300");
  if (!isRecord(option.extra) || option.extra.areFeesSponsored !== true) {
    fail("M9", "extra.areFeesSponsored must be true");
  }
  if (!ok || network === undefined || payTo === null) return undefined;
  return {
    protocol: "x402",
    x402Version: 2,
    scheme: "exact",
    network,
    asset: USDC_ASSET[network],
    payTo,
    maxTimeoutSeconds: option.maxTimeoutSeconds as number,
    feesSponsored: true,
  };
}

function readServices(value: unknown, report: Report): ManifestService[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SERVICES) {
    report("M9", `services must be an array of 1 to ${MAX_SERVICES} services`);
    return undefined;
  }
  const services: ManifestService[] = [];
  const names = new Set<string>();
  let ok = true;
  value.forEach((entry: unknown, index) => {
    const at = `services[${index}]`;
    const fail = (rule: string, message: string): void => {
      report(rule, `${at}: ${message}`);
      ok = false;
    };
    if (!isRecord(entry)) {
      fail("M9", "the service must be an object");
      return;
    }
    const name = typeof entry.name === "string" && SERVICE_NAME.test(entry.name) ? entry.name : undefined;
    if (name === undefined) fail("M9", "name must match ^[a-z0-9][a-z0-9_-]{0,63}$");
    else if (names.has(name)) fail("M7", "the service name is used twice");
    else names.add(name);

    const title = optional(entry.title, (v) => line(v, 1, 120));
    if (title === INVALID) fail("M9", "title must be 1–120 characters without control characters");
    const description = text(entry.description, 1, 1000);
    if (description === undefined) fail("M9", "description must be 1–1000 characters of text");

    const amount = isRecord(entry.price) && typeof entry.price.amount === "string" ? entry.price.amount : undefined;
    if (amount === undefined || !PRICE_AMOUNT.test(amount)) {
      fail("M9", "price.amount must be a positive integer string of at most 38 digits");
    }
    const charge = entry.charge === undefined ? "upfront" : entry.charge;
    if (charge !== "upfront" && charge !== "on-success") fail("M9", 'charge must be "on-success" or "upfront"');
    const expected = optional(entry.expectedDurationSeconds, (v) =>
      isInteger(v, 1, Number.MAX_SAFE_INTEGER) ? v : undefined,
    );
    if (expected === INVALID) fail("M9", "expectedDurationSeconds must be an integer of at least 1");
    else if (charge === "on-success" && expected === undefined) {
      fail("M9", "expectedDurationSeconds is required when charge is on-success");
    }
    const maxInputBytes = optional(entry.maxInputBytes, (v) => (isInteger(v, 1, MAX_INPUT_BYTES) ? v : undefined));
    if (maxInputBytes === INVALID) fail("M9", "maxInputBytes must be an integer from 1 to 10485760");

    const tags = optional(entry.tags, readTags);
    if (tags === INVALID) fail("M9", "tags must be up to 10 unique strings matching ^[a-z0-9-]{1,32}$");
    const capacity = optional(entry.capacity, readCapacity);
    if (capacity === INVALID) {
      fail("M9", "capacity must hold an integer concurrency of at least 1 and a maxQueueWaitSeconds of at least 0");
    }

    for (const field of ["inputSchema", "outputSchema"] as const) {
      const schema = entry[field];
      if (!isRecord(schema) || schema.type !== "object") fail("S4", `${field} must be a schema whose root is an object`);
    }
    if (entry.examples !== undefined && !readExamples(entry.examples)) {
      fail("M9", `examples must be up to ${MAX_EXAMPLES} objects with an input and an output object`);
    }
    if (entry.extensions !== undefined && !isRecord(entry.extensions)) fail("M9", "extensions must be an object");

    if (!ok || name === undefined || description === undefined || amount === undefined) return;
    services.push({
      name,
      price: { amount, asset: "USDC", decimals: USDC_DECIMALS, usdc: formatUsdc(amount) },
      charge: charge as ManifestService["charge"],
      expectedDurationSeconds: valueOrNull(expected),
      maxInputBytes: maxInputBytes === undefined ? DEFAULT_MAX_INPUT_BYTES : (maxInputBytes as number),
      capacity: valueOrNull(capacity),
      text: { title: valueOrNull(title), description, tags: tags === undefined ? [] : (tags as string[]) },
    });
  });
  return ok ? services : undefined;
}

function readTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_TAGS) return undefined;
  if (!value.every((t): t is string => typeof t === "string" && TAG.test(t))) return undefined;
  return new Set(value).size === value.length ? value : undefined;
}

function readCapacity(value: unknown): ManifestService["capacity"] | undefined {
  if (!isRecord(value)) return undefined;
  const concurrency = optional(value.concurrency, (v) => (isInteger(v, 1, Number.MAX_SAFE_INTEGER) ? v : undefined));
  const wait = optional(value.maxQueueWaitSeconds, (v) => (isInteger(v, 0, Number.MAX_SAFE_INTEGER) ? v : undefined));
  if (concurrency === INVALID || wait === INVALID) return undefined;
  return { concurrency: valueOrNull(concurrency), maxQueueWaitSeconds: valueOrNull(wait) };
}

function readExamples(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_EXAMPLES &&
    value.every((e) => isRecord(e) && isRecord(e.input) && isRecord(e.output))
  );
}

/** baseUrl per [M5] and the schema's pattern. */
function readBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_MANIFEST_URL_LENGTH) return undefined;
  return /^https:\/\/[^\s/?#@]+(\/[^\s/?#]+)*$/.test(value) ? value : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_MANIFEST_URL_LENGTH) return undefined;
  return /^https:\/\/[^\s/?#@]+([/?#]\S*)?$/.test(value) ? value : undefined;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** JSON Schema lengths count code points, not UTF-16 units. */
function lengthWithin(value: string, min: number, max: number): boolean {
  if (value.length < min) return false;
  const length = [...value].length;
  return length >= min && length <= max;
}

function line(value: unknown, min: number, max: number): string | undefined {
  return typeof value === "string" && lengthWithin(value, min, max) && LINE.test(value) ? value : undefined;
}

function text(value: unknown, min: number, max: number): string | undefined {
  return typeof value === "string" && lengthWithin(value, min, max) && TEXT.test(value) ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Marks an optional field that is present but invalid. */
const INVALID: unique symbol = Symbol("invalid");

/** undefined when absent, INVALID when present but rejected by `read`, else the read value. */
function optional<T>(value: unknown, read: (value: unknown) => T | undefined): T | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  const result = read(value);
  return result === undefined ? INVALID : result;
}

function valueOrNull<T>(value: T | undefined | typeof INVALID): T | null {
  return value === undefined || value === INVALID ? null : value;
}

function refuse(rule: string, message: string): ManifestReadResult {
  return { ok: false, problems: [{ rule, message }] };
}

function hasLoneSurrogate(value: unknown): boolean {
  // With the `u` flag a valid surrogate pair is one code point, so this matches only lone ones.
  const lone = /[\uD800-\uDFFF]/u;
  if (typeof value === "string") return lone.test(value);
  if (typeof value !== "object" || value === null) return false;
  for (const [key, member] of Object.entries(value)) {
    if (lone.test(key) || hasLoneSurrogate(member)) return true;
  }
  return false;
}

/**
 * Whether an object in `text` repeats a key, compared after unescaping. Call it
 * only on text JSON.parse accepted: it scans strings and brackets and relies on
 * the text being well-formed.
 */
export function hasDuplicateKey(text: string): boolean {
  const stack: Array<{ keys: Set<string>; expectKey: boolean } | null> = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const top = stack.at(-1);
    if (char === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (char === "[") stack.push(null);
    else if (char === "}" || char === "]") stack.pop();
    else if (char === ",") {
      if (top) top.expectKey = true;
    } else if (char === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (top?.expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = end;
    }
  }
  return false;
}
