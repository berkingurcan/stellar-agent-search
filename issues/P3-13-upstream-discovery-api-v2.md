# P3-13 — Upstream cursor-based discovery API v2

**Owner:** Upstream Stellar8004 · **Status:** filed — [trionlabs/stellar-8004#18](https://github.com/trionlabs/stellar-8004/issues/18)

## Problem

This MCP correctly consumes the existing Stellar 8004 Explorer API/SDK, but discovery is bounded by v1
page/offset pagination and client-side text matching. `find_agent` inspects at most 200 candidates,
query-mode `rank_agent` 100, and other ranked surfaces have their own hard caps. Those caps are necessary
denial-of-service controls; they cannot become a claim that the global best match was considered as the
number of agents grows.

The canonical indexer and Supabase/Postgres read model already live in `trionlabs/stellar-8004`. Building a
second indexer or letting the MCP query Supabase directly would split truth, leak an administrative boundary,
and couple this repo to database internals.

The current v1 handler also constructs its count query with `{ count: 'exact', head: false }` and no range,
then discards the returned rows before issuing a second paginated data query. That makes list cost grow with
the qualifying registry even when the caller requests a small page. Count-query errors are not checked, so a
database failure can be reported as `total: 0`. The v1 compatibility fix is `head: true` plus explicit error
handling; v2 must make bounded query cost an acceptance property.

Two continuation defects are independent of the scan cap. The v1 list/account routes order by only
`created_at` or `id`; `created_at` has no unique secondary tie-breaker, so equal timestamps have no total
order, and offset pages can duplicate or skip rows even without a write between requests. With concurrent
writes, every offset walk is additionally snapshot-inconsistent. The v1 `/search` route always calls the
advanced search RPC with `result_offset: 0`, exposes only `limit`, and returns no continuation cursor, so a
consumer cannot ask for the next result window. The MCP avoids claiming completeness; v2 must solve these at
the canonical query boundary rather than hiding them behind a larger client scan.

## Decision

Implement the contract in [docs/stellar8004-integration.md](../docs/stellar8004-integration.md):

- upstream indexer + Supabase remain the source of indexed truth;
- Explorer API/SDK remain the only product read boundary;
- the MCP never receives a service-role key or queries Supabase/PostgREST directly;
- a same-account Cloudflare Service Binding calls the same versioned API boundary, not the database; and
- optional Soroban reads remain a bounded reachability/evidence overlay, not a second store.

The scale fix is additive `GET /api/v2/discovery`: server-side structured/text filters, stable total ordering,
keyset cursors pinned to a projection revision, explicit network and freshness watermarks, honest coverage,
and ETag/cache semantics. v1 remains compatible during rollout.

## Why this is tracked here first

The upstream repo has a `CONTRIBUTING.md` covering setup, code style, tests, and PR mechanics, but no checked-in
backlog index or API/architecture proposal acceptance gate was found. There is therefore no accepted upstream
artifact to link yet. This repo is the immediate consumer and must retain a reviewable acceptance contract
instead of hiding the dependency in chat or an unowned TODO.

The upstream tracking artifact is [trionlabs/stellar-8004#18](https://github.com/trionlabs/stellar-8004/issues/18).
It is filed, not yet an accepted design: implementation remains gated on an upstream owner/ADR decision.
Keep this file and the integration document as the MCP-side compatibility/acceptance mirror.

## Work split

### `trionlabs/stellar-8004`

- Add the v2 database query/projection needed for complete filtered text discovery without an internal
  candidate cap.
- Add retained immutable discovery revisions, `asOfLedger`, `indexedAt`, stale/integrity gates, and exceptional
  cursor invalidation.
- Add `/api/v2/discovery` with the exact filter, sort, cursor, response, error, ETag, and cache contract.
- Add the `/api/v2/discovery` route to the upstream Worker allowlist.
- Publish typed SDK request/response/error types and `discoverAgentsV2`, preserving injected `fetch` support.
- Keep Supabase credentials and database implementation entirely upstream.

### This repository

- Add an SDK-backed v2 adapter only after the upstream method is published.
- Preserve current MCP ranking, self-declared-data labeling, and bounded top-K Soroban verification.
- Map v2 query coverage and `hasMore` into honest MCP coverage fields.
- Shadow-compare v2 with v1 before making v2 the default.
- If a temporary v1 fallback is retained, label it and force incomplete coverage; never fall back to Supabase.
- For remote deployment, inject Service-Binding-backed `fetch` into the same SDK path used locally.

## Acceptance criteria

- [ ] Upstream has an accepted issue/ADR linked from this file, with owners for API, SDK, and indexer work.
- [ ] Contract tests cover every `network`, `x402`, `mpp`, `hasServices`, `trust`, `minScore`, `text`, `sort`,
      `limit`, and unknown-parameter case, including strict `false` filters.
- [ ] `minScore` and `sort=score` use the versioned 0–100 normalized discovery score; negative, greater-than-
      100, and very large protocol-valid raw feedback values neither overflow nor outrank the normalized cap.
- [ ] Raw score averages cross the v2 boundary as canonical decimal strings, with SDK precision tests.
- [ ] Stable-sort tests prove tie-breakers and no duplicate/missing rows across a cursor walk on one
      `projectionRevision`.
- [ ] Every supported order is total: score/relevance/created-at sorts include an immutable unique id
      tie-breaker, and the cursor encodes every ordering component.
- [ ] Text search returns `hasMore`/`nextCursor`; continuation preserves the normalized query and cannot
      silently restart at offset zero.
- [ ] A cursor keeps reading its immutable projection revision when a newer revision is published; the old
      revision remains available for the full five-minute cursor lifetime.
- [ ] Cursor tests cover tampering, query mismatch, expiry, and exceptional `CURSOR_STALE` after early
      eviction/reconciliation; normal visible projection changes do not starve an active walk.
- [ ] A successful v2 response has `asOfLedger`, `indexedAt`, `hasMore`, `nextCursor`, score/search versions,
      and `coverage.scope = indexed_projection` with `queryComplete = true`.
- [ ] `asOfLedger` reflects the oldest data actually incorporated into the discovery/score projection, not a
      newer indexer checkpoint when a materialized score refresh is still pending.
- [ ] Query truncation, stale checkpoints, integrity degradation, or detected rollback fail closed with the
      documented 503 error; they are not returned as complete 200 responses.
- [ ] ETag/304 and cache headers vary on the normalized query, cursor page, versions, network, and projection
      revision; partial/stale/error responses are `no-store`.
- [ ] Public HTTP and Service-Binding-backed SDK tests return equivalent status/body/cache/error semantics.
- [ ] The remote MCP binding contains no Supabase URL, service-role key, database password, PostgREST client,
      or direct database RPC.
- [ ] MCP shadow telemetry compares membership, order, `hasMore`, coverage, and fallback rate without logging
      raw search text or agent metadata.
- [ ] v2 is made default only after freshness/integrity alerts and public-vs-binding canaries are live.
- [ ] `/api/v1` and existing SDK methods remain backward compatible until a separately announced deprecation.
- [ ] While v1 remains live, list count queries use `head: true`, every Supabase error is checked, and a
      one-row/page request does not materialize the full qualifying agent set.

## Non-goals

- Replacing the upstream indexer or Supabase.
- Moving canonical registry state into Cloudflare storage.
- Making the MCP's ranking formula canonical upstream truth.
- Treating indexed data as on-chain verification.
- Adding writes, wallets, or private keys to the MCP.
