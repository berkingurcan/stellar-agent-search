/**
 * text-match.ts — the keyword match both discovery sources run client-side, and
 * the record of why each row matched.
 *
 * Deterministic and offline: no LLM, no embeddings, no I/O.
 *
 *   Query  folded by normalizeSearchText (NFKD, combining marks stripped, dotless
 *          ı → i, lowercased), split into letter/digit runs, runs shorter than
 *          two characters dropped, each run stemmed once (stem()), duplicates
 *          dropped. Stopwords and filter words are removed before this, by
 *          nlparse.ts residualKeywords; this module matches the words it is given.
 *   Text   folded the same way, never split or stemmed: a stem matches when it
 *          occurs anywhere in a field, so "scraper" (stem "scrap") finds
 *          "Scrapper" and "scrapes".
 *   Fields name, description, and the registration's service entries (each
 *          entry's name and endpoint). Where a source reads them (registry
 *          mode), also the services a provider's bound Provider Standard
 *          manifest lists: each service's name, title, description and tags.
 *   "any"  a row matches when one stem occurs in one field.
 *   "all"  every stem must occur in some field. When no row qualifies, the
 *          search relaxes to "any" rather than return nothing.
 *
 * A row that matched records which fields held a query word, and which manifest
 * services did. Field names are server vocabulary; the service names and titles
 * are provider text, for the caller to sanitize into a selfDeclared slot.
 */

import type { AgentResponse } from "@trionlabs/stellar8004";
import { normalizeSearchText, unicodeTokens } from "./nlparse.js";

/** The text a search reads, by where it comes from. */
export type MatchField = "name" | "description" | "registrationServices" | "manifestServices";

/** Field order in a match record. */
const FIELD_ORDER: readonly MatchField[] = ["name", "description", "registrationServices", "manifestServices"];

/** A manifest service as a search reads it. Raw provider text. */
export interface ServiceText {
  name: string;
  title: string | null;
  description: string;
  tags: readonly string[];
}

/** Why a search kept a row. `manifestServices` is raw provider text. */
export interface AgentMatch {
  /** The fields that held at least one query word, in FIELD_ORDER. */
  fields: MatchField[];
  /** The manifest services whose name, title, description or tags held a query word. */
  manifestServices: Array<{ name: string; title: string | null }>;
}

export type MatchMode = "all" | "any";

/**
 * The stems a query searches for. [] for an empty query, which filters nothing;
 * null for a query with text but no word of two or more characters, which the
 * caller reports instead of returning everything.
 */
export function queryStems(query: string): string[] | null {
  const q = (query ?? "").trim();
  if (!q) return [];
  // Keep 2-char stems (ai/ml/os/db/3d/io): dropping them made match:"all" stop
  // REQUIRING those tokens, so "ai agent" wrongly matched "Payment Agent".
  // stem() never shortens a token below three characters, so none drops out here.
  const stems = unicodeTokens(q)
    .filter((t) => t.length >= 2)
    .map(stem);
  return stems.length > 0 ? [...new Set(stems)] : null;
}

/** The query stems one row holds, by field. Manifest services are added once they are read. */
export class RowHits {
  private readonly stems: readonly string[];
  private readonly found = new Set<string>();
  private readonly fields = new Set<MatchField>();
  private readonly services: Array<{ name: string; title: string | null }> = [];

  constructor(stems: readonly string[]) {
    this.stems = [...new Set(stems)];
  }

  /** Record the stems `text` holds under `field`. */
  add(field: MatchField, text: string): void {
    const folded = normalizeSearchText(text);
    for (const s of this.stems) {
      if (!folded.includes(s)) continue;
      this.found.add(s);
      this.fields.add(field);
    }
  }

  /** Record a manifest service, which counts when its name, title, description or tags hold a stem. */
  addService(service: ServiceText): void {
    const folded = normalizeSearchText(
      [service.name, service.title ?? "", service.description, ...service.tags].join(" "),
    );
    let hit = false;
    for (const s of this.stems) {
      if (!folded.includes(s)) continue;
      this.found.add(s);
      hit = true;
    }
    if (!hit) return;
    this.fields.add("manifestServices");
    this.services.push({ name: service.name, title: service.title });
  }

  /** "any": one stem found. "all": every stem found, in any field. */
  satisfies(mode: MatchMode): boolean {
    return mode === "any" ? this.found.size > 0 : this.found.size === this.stems.length;
  }

  match(): AgentMatch {
    return {
      fields: FIELD_ORDER.filter((f) => this.fields.has(f)),
      manifestServices: [...this.services],
    };
  }
}

/** A row's registration text: name, description, and each service entry's name and endpoint. */
export function registrationHits(a: AgentResponse, stems: readonly string[]): RowHits {
  const hits = new RowHits(stems);
  hits.add("name", a.name ?? "");
  hits.add("description", a.description ?? "");
  hits.add(
    "registrationServices",
    (a.services ?? []).map((s) => `${s?.name ?? ""} ${s?.endpoint ?? ""}`).join(" "),
  );
  return hits;
}

/**
 * The rows that match in `mode`, in their input order, and why each matched.
 * "all" relaxes to "any" when no row qualifies, so a multi-word query still
 * surfaces the closest rows rather than nothing.
 */
export function selectMatches(
  rows: readonly AgentResponse[],
  hits: ReadonlyMap<AgentResponse, RowHits>,
  mode: MatchMode,
): { agents: AgentResponse[]; matches: Map<number, AgentMatch> } {
  const pick = (m: MatchMode) => rows.filter((a) => hits.get(a)?.satisfies(m) === true);
  let agents = pick(mode);
  if (agents.length === 0 && mode === "all") agents = pick("any");
  const matches = new Map<number, AgentMatch>();
  for (const a of agents) if (!matches.has(a.id)) matches.set(a.id, hits.get(a)!.match());
  return { agents, matches };
}

/**
 * The registration-text match over `agents`. An empty query keeps every row and
 * records no reasons. Returns null when the query has text but no search word,
 * so the caller can say so instead of returning everything.
 */
export function matchRows(
  agents: AgentResponse[],
  query: string,
  mode: MatchMode,
): { agents: AgentResponse[]; matches?: Map<number, AgentMatch> } | null {
  const stems = queryStems(query);
  if (stems === null) return null;
  if (stems.length === 0) return { agents };
  const hits = new Map(agents.map((a) => [a, registrationHits(a, stems)] as const));
  return selectMatches(agents, hits, mode);
}

/** The rows `matchRows` keeps, without the reasons. */
export function matchAgentsByQuery(
  agents: AgentResponse[],
  query: string,
  mode: MatchMode,
): AgentResponse[] | null {
  return matchRows(agents, query, mode)?.agents ?? null;
}

/**
 * Crude English stem: strip a common trailing suffix down to a root of ≥3 chars.
 * Used for substring matching against the RAW haystack, so a stemmed query token
 * ("scrap" from "scraper"/"scraping") still hits an unstemmed on-chain name
 * ("Scrapper", "Scrapes"). Deliberately loose — discovery ranks results after.
 */
export function stem(token: string): string {
  const t = token.toLowerCase();
  for (const suf of ["ping", "ning", "ging", "ing", "pers", "per", "ers", "er", "es", "ed", "s"]) {
    if (t.endsWith(suf) && t.length - suf.length >= 3) return t.slice(0, t.length - suf.length);
  }
  return t;
}
