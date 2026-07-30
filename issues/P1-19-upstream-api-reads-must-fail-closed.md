# P1-19 — Remaining upstream API reads must fail closed

**Owner:** Upstream Stellar 8004 · **Status:** local finding; not yet filed upstream

## Problem

At inspected upstream commit `d92c2f4`, several Supabase results are destructured without checking `error`.
An HTTP 200 can therefore contain empty, zero, or partial data that looks authoritative. The primary data
query and `/search` error paths are checked; the remaining gaps are still material:

- agent list count and score-enrichment reads;
- agent detail leaderboard-score and metadata reads;
- feedback count and feedback-response reads;
- account/owner count and score-enrichment reads;
- all health `indexer_state` reads (missing/error rows become stale zeros while top-level status stays
  `healthy`); and
- the `/stats` reads already tracked in [P1-15](P1-15-upstream-stats-must-fail-closed.md).

`count ?? 0`, `data ?? []`, and a missing score entry are valid only after a successful query. They must not
serve as database-error recovery.

## Acceptance criteria

- [ ] Every Supabase query result is named and checked before any response is assembled.
- [ ] A failed mandatory count/data/enrichment query returns a typed 5xx `QUERY_ERROR`, never a plausible 200.
- [ ] Error responses are `no-store`; a CDN or MCP cache cannot retain a fabricated empty result.
- [ ] Optional enrichment is explicitly versioned and labeled partial if the product deliberately chooses
      degraded output; score/metadata fields are never silently omitted on query failure.
- [ ] `/health` returns degraded/503 when any mandatory state read errors, distinct from a successful read of
      a genuinely missing/cold checkpoint.
- [ ] Tests inject an error into each query position above and assert status, body, and cache headers.
- [ ] Public HTTP and Service Binding paths have the same failure semantics.

## Local containment

The MCP runtime-validates agent rows, stats, and health payloads and maps malformed HTTP-success payloads to
`UPSTREAM_ERROR`. It cannot detect every semantically plausible zero/empty response, so upstream error
handling remains required.
