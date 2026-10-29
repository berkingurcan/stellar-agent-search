/**
 * http.ts — bounded reads of documents a registrant chose: registration files
 * and Provider Standard manifests.
 *
 * Both URLs come from a permissionless registry, so a read is HTTPS only, has a
 * deadline and a size cap, and follows no redirect. On top of that, a host that
 * names a local or private network directly (an IP literal, `localhost`, a
 * single-label name, `*.local`, `*.internal`) is refused before any request, so
 * a manifest URL cannot turn this server into a probe of the network it runs
 * on. A public name that resolves to a private address is not caught here: a
 * shared deployment should run where it can reach only the public internet.
 */

/** Hostname suffixes that only ever name a local or private network. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** Why a URL is not a public HTTPS URL. */
export type UrlProblem = "too-long" | "unparseable" | "not-https" | "user-info" | "ip-address" | "local-host";

/** Server-authored descriptions; none quotes the URL. */
export const URL_PROBLEM_MESSAGES: Readonly<Record<UrlProblem, string>> = {
  "too-long": "the URL is too long",
  unparseable: "the URL does not parse",
  "not-https": "the URL is not HTTPS",
  "user-info": "the URL has user info",
  "ip-address": "the URL names an IP address instead of a host name",
  "local-host": "the URL names a local host",
};

/** Why `raw` is not a public HTTPS URL of at most `maxLength` characters, or null when it is. */
export function publicHttpsUrlProblem(raw: string, maxLength: number): UrlProblem | null {
  if (raw.length > maxLength) return "too-long";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "unparseable";
  }
  if (url.protocol !== "https:") return "not-https";
  if (url.username !== "" || url.password !== "") return "user-info";
  // WHATWG URL parsing normalizes every IPv4 spelling (0x7f.1, 2130706433…) to
  // dotted decimal and keeps IPv6 in brackets, so these two tests catch every
  // IP literal.
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return "ip-address";
  if (host === "localhost" || !host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return "local-host";
  }
  return null;
}

/** A response body ran past its size cap. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("file is too large");
    this.name = "BodyTooLargeError";
  }
}

/** Read a response body, stopping with BodyTooLargeError once it exceeds `max` bytes. */
export async function readCappedBytes(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLargeError();
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Read a response body as UTF-8, stopping once it exceeds `max` bytes. */
export async function readCappedText(response: Response, max: number): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readCappedBytes(response, max));
}
