# Stellar 8004 integration contract

**Status:** proposed target contract; the current implementation still uses the bounded v1 path described
below. Consumer tracking: [P3-13](../issues/P3-13-upstream-discovery-api-v2.md). Upstream proposal:
[trionlabs/stellar-8004#18](https://github.com/trionlabs/stellar-8004/issues/18) (filed; not yet accepted).
Related upstream gaps are the complete bounded reputation aggregate
[#19](https://github.com/trionlabs/stellar-8004/issues/19) and SDK service-field preservation
[#20](https://github.com/trionlabs/stellar-8004/issues/20); neither is implemented in the current consumer.

This document defines the ownership and communication boundary between this MCP server and the canonical
[`trionlabs/stellar-8004`](https://github.com/trionlabs/stellar-8004) indexer, database, Explorer API, and
SDK. It also specifies the discovery API needed when the registry grows beyond the MCP's current bounded
candidate windows.

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative in the proposed v2 sections.

## Decision

There is one registry/indexing system, not two:

```text
Stellar contracts
      │ authoritative on-chain events/state
      ▼
stellar-8004 indexer
      │ canonical projection writer
      ▼
Supabase/Postgres
      │ source of indexed truth
      ▼
versioned public Explorer API
      │ product read boundary
      ▼
@trionlabs/stellar8004 SDK
      │ typed client, retries, normalization
      ▼
stellar-agent-mcp
      └── optional bounded Soroban contract-reachability probe
```

The MCP is a read-only consumer and ranking/presentation layer. It is **not** another indexer, registry,
database, or source of truth.

- Stellar contracts remain authoritative for on-chain state.
- The upstream indexer plus Supabase/Postgres are the canonical indexed read model: the *source of indexed
  truth*, not a replacement for the chain.
- The versioned Explorer API is the only product read boundary. The SDK owns its request/response types,
  retry policy, and normalization.
- The MCP owns discovery intent parsing, its explicit ranking policy, output safety, MCP tools/resources, and
  optional top-K contract reachability attempts.
- Soroban evidence is a bounded, fail-closed probe. The current release cannot prove client-set exhaustion,
  so it compares no reputation fields: average, feedback count, and `uniqueClients` all remain
  indexer-declared. It MUST NOT write a competing canonical value to Supabase or an MCP-owned database/cache.

## Repository and package decision

The two repositories are both part of the product, but they have different release and security boundaries.
At the inspected upstream commit (`d92c2f4`), `trionlabs/stellar-8004` contains the contracts, indexer,
Supabase schema/API, Explorer UI, and published `@trionlabs/stellar8004` SDK. It does **not** contain an MCP
protocol server, Streamable HTTP handler, MCP package manifest, or MCP client-setup CLI. Its current "MCP"
references describe agent service metadata/examples; they are not a reusable MCP runtime.

One similarly named upstream document needs an explicit distinction:
`docs/findings/supabase/02-self-hosted-mcp-setup.md` describes Supabase Studio's operator/admin MCP for
database maintenance behind SSH/IP restrictions. It is not a Stellar 8004 agent-registry MCP, is not the
public Explorer read contract, and must not be copied, Service-Bound, or exposed as this product's runtime.
The reusable boundary from `stellar8004.com` is the versioned public Explorer API/SDK; this repo supplies the
agent-facing MCP adapter over that boundary.

| Surface | Canonical home | How this repo uses it |
|---|---|---|
| Contracts, event semantics, network addresses | `trionlabs/stellar-8004` | Imports versioned generated bindings/config; never copies them |
| Indexer, Supabase schema, read projections | `trionlabs/stellar-8004` | Reads only through the versioned Explorer API |
| Low-level TypeScript SDK | `@trionlabs/stellar8004` from the upstream repo | Exact dependency pin; SDK changes are released upstream first |
| Human CLI, MCP tools/resources/prompts, client setup | this repo | One install surface: `stellar-agent-mcp` |
| Remote MCP transport and Cloudflare admission controls | this repo | Calls `stellar8004-web` through an HTTP Service Binding |

The CLI therefore **does belong here and already is here**. The SDK should be available to users, but not
forked or vendored here: copying it would create two definitions of API pagination, errors, contract
addresses, and network configuration. Programmatic consumers install `@trionlabs/stellar8004`; MCP/terminal
consumers install `stellar-agent-mcp`, which depends on that exact SDK release internally.

A future monorepo move could place this package under `stellar-8004/webapp/packages/`, but it is an
organizational choice, not an integration fix. Keeping the public MCP runtime separate currently gives a
smaller publish/deploy blast radius and lets the indexer/contract release train remain independent. Revisit
that only when both packages share owners, CI gates, disclosure policy, and coordinated versioning. Do not
merge the data planes merely to make the source tree look unified.

## Hard security and ownership boundary

The MCP MUST NOT:

- connect to Supabase/Postgres or PostgREST directly;
- receive `SUPABASE_SERVICE_ROLE_KEY`, a database password, or another upstream administrative credential;
- query an upstream table, view, or RPC directly, even if that object currently grants `anon` access;
- run a second Stellar 8004 indexer;
- copy the registry into Cloudflare D1, KV, Durable Objects, or another shadow datastore; or
- fall back to the database when the Explorer API is unavailable.

The upstream public API currently uses an administrative Supabase client internally. That is an upstream
implementation and security responsibility; it is not permission to propagate the service-role credential
to this repo. Private Supabase operator tooling is likewise a maintenance plane, never a runtime dependency.

This separation matters for more than secret hygiene. A direct database consumer would couple this MCP to
upstream migrations, bypass API rate limits and response normalization, create two definitions of
pagination/freshness, and make a later indexer correction impossible to roll out atomically.

## Local and Cloudflare communication

### Local stdio MCP (current)

`ExplorerService` calls `ExplorerClient` from `@trionlabs/stellar8004`; the default public base URL is
`https://stellar8004.com`. The SDK supplies typed API errors, normalization, timeout/retry behavior, and
`Retry-After` handling. The MCP adds only process-local TTL caching and keyed single-flight. The exact current
pin is `0.0.11`; its service normalizer has the field-preservation defect documented below, so the MCP does
not invent the missing fields or bypass the SDK to recover them.

```text
local MCP process -> ExplorerClient -> https://stellar8004.com/api/v1/*
```

### Remote MCP on Cloudflare (target)

A remote MCP Worker in the same Cloudflare account SHOULD use the HTTP
[Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)
interface to the existing `stellar8004-web` Worker. It MUST still issue a normal versioned Explorer API
request through that Worker's API route:

```text
remote MCP Worker
      │ env.STELLAR8004_API.fetch(Request)
      ▼
stellar8004-web Worker /api/v2/*
      ▼
upstream API implementation -> Supabase/Postgres
```

The binding is transport, not privileged data access. It MUST NOT expose or bind a Supabase service-role key,
and it MUST NOT import upstream database code. The HTTP form is deliberate: it preserves the public API's
request/response contract rather than creating a second RPC contract. It also keeps Worker-to-Worker traffic
off the public URL and avoids depending on the optional
[`global_fetch_strictly_public`](https://developers.cloudflare.com/workers/runtime-apis/fetch/#worker-to-worker)
compatibility path.

The SDK remains the request-contract owner in both deployments. The remote adapter injects a binding-backed
`fetch` implementation into `ExplorerClient`; local stdio uses normal `fetch`. Public HTTP and binding-backed
calls MUST produce the same status, body, cache, cursor, and error semantics. The trusted binding path SHOULD
forward a request/trace ID and the original client-rate-limit identity without accepting a spoofable public
header as that identity.

The public route MAY use the CDN cache for safe Explorer `GET` responses. A Service Binding is not assumed to
traverse that public cache; an explicit Worker Cache API layer, if added, must obey the same upstream
`Cache-Control`/ETag contract. Neither path may cache Streamable HTTP/MCP JSON-RPC `POST` responses as
registry data.

## What exists today

The current v1 integration is useful and intentionally honest, but not globally complete at arbitrary scale:

| Concern | Current behavior |
|---|---|
| Read boundary | `ExplorerService` wraps the upstream `ExplorerClient`; there is no Supabase dependency |
| Network | Mainnet by default; testnet requires an explicit Explorer URL rather than silently reading mainnet |
| Filters | MCP `x402`, `mpp`, `hasServices`, `trust`, and explicit `minExplorerScore` are sent to the v1 list (`minExplorerScore` maps to upstream `minScore`; it is not local rank) |
| Text | The v1 list projection omits `services[]`, so the bounded first-pass stem match can use only fetched agent name/description; service text is not globally searchable today |
| Pagination | v1 uses page/offset pagination; every MCP walk has a hard page cap |
| Coverage | `hasMore: false` proves only that the observed v1 pagination ended; without a revision-bound snapshot, v1 always reports `coverageComplete: false` and `snapshotConsistent: false` |
| Reliability | SDK timeout/retries/rate-limit handling plus process-local TTL cache and single-flight |
| Reputation evidence | One optional bounded Soroban client-page probe; reachable attempts still return `unavailable`, `verifiedFields: []`, and `snapshotComparable: false` because exhaustion is unprovable |

The concrete candidate ceilings are:

| Consumer | Window | Coverage surfaced? |
|---|---:|---|
| `find_agent` | 4 × 50 = 200 filtered candidates | Yes |
| query-mode `rank_agent` | 2 × 50 = 100 filtered candidates | Yes |
| `list_services` | enough 50-row pages for the requested window, capped at 10 pages | Yes |
| `leaderboard` tool | 3 × 50 = 150 candidates | Yes |
| leaderboard/list resources | at most 5 × 50 = 250 candidates | Yes |

These are bounded-work safety controls, not claims of global ranking. A match beyond a capped window can be
missed. `coverageComplete`, `paginationExhausted`, `snapshotConsistent`, `pagesScanned`, `recordsScanned`,
and `hasMore` prevent the discovery tools from presenting that window as the whole registry. Because v1 is
offset-paginated with no revision cursor, every v1 result is conservatively `snapshotConsistent: false` and
`coverageComplete: false`, including a single page that ends with `hasMore: false`. That final flag is retained
as `paginationExhausted: true`; it is useful progress evidence, not a global-completeness proof. The v2 contract
below moves filtering, text retrieval, stable ordering, and cursor pagination to the canonical indexed read
boundary.

Two other v1 limits remain explicit:

- the owner SDK method exposes only the current first page (up to 20 rows), so owner tools/resources return
  coverage rather than claiming "all agents"; and
- the current contract `get_summary` silently processes at most five caller-supplied client addresses, while
  `get_clients_paginated` compacts around expired index entries and exposes no authoritative count/cursor.
  A finite page therefore cannot prove that a later retained client does not exist. The verifier performs one
  bounded client-page reachability read and then stops: it does not call `get_summary`, remove/filter a
  supposedly complete set, or compare average/count. Attempted results are `unavailable` with
  `reason: client-set-exhaustion-unprovable`, `verifiedFields: []`, and `snapshotComparable: false`; all
  reputation values stay indexer-declared. A maintained upstream aggregate is required before field-scoped or
  complete-field evidence can be emitted.
  That contract/SDK work is tracked in
  [trionlabs/stellar-8004#19](https://github.com/trionlabs/stellar-8004/issues/19) and
  [P3-14](../issues/P3-14-upstream-reputation-aggregate-v2.md).

### SDK 0.0.11 service-field preservation gap

The live Explorer API can serialize a service with `name`, `endpoint`, `version`, `description`, and
`inputExample`, and the published TypeScript declaration exposes the last two as optional. However,
`@trionlabs/stellar8004@0.0.11` rebuilds each service at runtime with only `name`, `endpoint`, and `version`.
Consequently, even a detail hydration through `ExplorerClient.getAgent()` loses `description` and
`inputExample` before this MCP receives the record. Combined with the v1 list projection omitting
`services[]`, current discovery cannot honestly claim service-text search, and `list_services` can expose only
the normalized basics as self-declared endpoint candidates.

The MCP MUST NOT query Supabase, call a private API, or hand-parse a second response path to reconstruct those
fields. The fix belongs in the upstream SDK and is tracked by
[trionlabs/stellar-8004#20](https://github.com/trionlabs/stellar-8004/issues/20). Acceptance requires a new
exact SDK release whose runtime output matches its declaration, fixtures proving both optional fields survive
an API-shaped detail response, and backward-compatible normalization when either field is absent. Only after
that release may this repo bump its exact pin and remove this limitation.

## Proposed Explorer discovery API v2

### Endpoint

```http
GET /api/v2/discovery
```

It is a public, read-only, side-effect-free endpoint. Unknown query parameters MUST return `400
UNKNOWN_QUERY_PARAMETER`; accepting misspelled filters as an unfiltered query is unsafe.

### Query contract

| Parameter | Required | Exact contract |
|---|---|---|
| `network` | Yes | `mainnet` initially; an unsupported value returns `422 UNSUPPORTED_NETWORK`. It is never inferred from an MCP default. |
| `text` | No | Trimmed Unicode text, 1–256 code points. Empty-after-trim is invalid; absence means no text filter. Search covers bounded name, description, and service-name fields in the full indexed projection. |
| `x402` | No | Strict `true` or `false`; absent means no filter. Both values MUST filter, unlike a truthy-only implementation. |
| `mpp` | No | Strict `true` or `false`; absent means no filter. Both values MUST filter. |
| `hasServices` | No | Strict `true` or `false`; absent means no filter. Both values MUST filter. |
| `trust` | No | One to eight comma-separated, unique trust tokens; overlap/OR semantics. Each lower-case token matches `[a-z0-9][a-z0-9._-]{0,39}`. Known `tee-attestation` input normalizes to `tee`; tokens are sorted lexically for query hashing. This does not freeze future registry trust models to the MCP's three current choices. |
| `minScore` | No | Decimal in `[0,100]`, evaluated against `score.normalized` under the response's `scoreVersion`; absent means no minimum. NaN/infinity are invalid. It is never compared directly with an unbounded raw feedback value. |
| `sort` | No | `relevance`, `score`, `newest`, or `id`. Default is `relevance` when `text` is present, otherwise `score`. `relevance` without `text` is invalid. |
| `limit` | No | Integer `1..100`, default `20`. It is the page size, not a server scan budget. |
| `cursor` | No | Opaque cursor returned as `nextCursor`. All other query parameters MUST repeat with the same canonical values on the next request. |

Example first page:

```http
GET /api/v2/discovery?network=mainnet&text=invoice%20agent&x402=true&mpp=false&hasServices=true&trust=reputation,validation&minScore=60&sort=relevance&limit=20
```

The text implementation MUST be server-side and versioned by `searchVersion`. The initial `fts-v1` profile
SHOULD combine weighted full-text search with a bounded typo-tolerant fallback so that spelling variants do
not force the MCP to rescan the registry. A change that can alter match membership or relevance ordering MUST
bump `searchVersion`; it cannot silently change beneath an existing cursor.

### Stable sort and cursor invariants

Every sort is a total order. The initial `stellar8004-discovery-v1` score profile computes
`score.normalized = clamp(decimal(score.averageRaw ?? "0"), 0, 100)`. This is deliberately separate from
the on-chain raw average: the reputation contract accepts values far outside the product's 0–100 display
scale, so a raw value MUST NOT overflow or dominate discovery ordering. Changing this formula requires a new
`scoreVersion`. Null `createdLedger` values are normalized to zero.

| `sort` | Ordered tuple |
|---|---|
| `relevance` | `textRank DESC, score.normalized DESC, uniqueClients DESC, id ASC` |
| `score` | `score.normalized DESC, uniqueClients DESC, feedbackCount DESC, id ASC` |
| `newest` | `createdLedger DESC, id ASC` |
| `id` | `id ASC` |

The API MUST use keyset pagination, not page/offset. The cursor is an opaque, authenticated, base64url token
containing at least:

- cursor format version;
- expiry (five minutes from issuance);
- hash of the canonical network/filter/text/sort/limit query;
- `searchVersion`, `scoreVersion`, and `projectionRevision`;
- the last item's complete ordered tuple; and
- the first page's `asOfLedger` and `indexedAt` watermark.

The client MUST NOT decode or construct cursors. A malformed or tampered cursor returns `400 INVALID_CURSOR`;
a changed query returns `400 CURSOR_QUERY_MISMATCH`; an expired cursor returns `410 CURSOR_EXPIRED`.

`projectionRevision` identifies an immutable, finalized discovery generation and its incorporated
`asOfLedger`/`indexedAt` watermarks. A first-page request uses the latest fresh generation. The API MUST keep
that generation queryable for at least the full five-minute cursor lifetime, using versioned rows, retained
materialized generations, or an equivalent implementation. A newer generation does not change an existing
cursor walk; new/updated agents appear on the next walk.

This retention is load-bearing. Merely returning `409` whenever any agent changes can starve a full scan in
an active registry. `409 CURSOR_STALE` is reserved for an exceptional early revision eviction, reconciliation,
or rollback; it is not the normal response to a newer revision. This gives a cursor walk a coherent view
without pretending Postgres can hold one transaction open across HTTP requests.

### Success response

The list representation is deliberately bounded; full metadata and service endpoints remain detail calls.
`name` and `description` are self-declared, untrusted data even though they pass through the canonical API.

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 42,
        "owner": "G...",
        "wallet": "G...",
        "agentUri": "ipfs://...",
        "name": "Invoice Agent",
        "description": "Self-declared description",
        "supportedTrust": ["reputation"],
        "x402Enabled": true,
        "mppEnabled": false,
        "hasServices": true,
        "createdAt": "2026-07-29T12:34:56.000Z",
        "createdLedger": 123456,
        "txHash": "...",
        "score": {
          "normalized": 91.2,
          "averageRaw": "91.2",
          "feedbackCount": 12,
          "uniqueClients": 9
        }
      }
    ],
    "nextCursor": "eyJ..."
  },
  "meta": {
    "version": "2.0.0",
    "chain": "stellar",
    "network": "mainnet",
    "requestId": "01K...",
    "timestamp": "2026-07-29T12:35:01.000Z",
    "searchVersion": "fts-v1",
    "scoreVersion": "stellar8004-discovery-v1",
    "projectionRevision": "01K...",
    "asOfLedger": 123456,
    "indexedAt": "2026-07-29T12:34:58.000Z",
    "hasMore": true,
    "coverage": {
      "scope": "indexed_projection",
      "queryComplete": true
    }
  }
}
```

Normative field rules:

- `items` contains at most `limit` rows. `id` is a non-negative JSON-safe integer. `owner` is a valid Stellar
  account address; malformed indexed identity data is an integrity error, not a best-effort row.
- `wallet`, `agentUri`, `name`, `description`, `createdAt`, `createdLedger`, and `txHash` are nullable. A
  non-null `createdLedger` is a JSON-safe integer and `createdAt` is an RFC 3339 timestamp. List output bounds
  `agentUri` to 2,048, `name` to 200, and `description` to 2,000 Unicode code points.
- `supportedTrust` is a de-duplicated, lexically sorted array of at most 20 normalized trust tokens using the
  query token grammar; the upstream `tee-attestation` alias normalizes to `tee`. Capability fields are strict
  booleans. The current MCP may expose only its known `reputation`, `validation`, and `tee` filters without
  constraining the upstream API's extension vocabulary.
- `nextCursor` is non-null if and only if `hasMore` is true.
- `score.normalized` is a finite number in `[0,100]`. `score.averageRaw` is a canonical decimal string or
  `null`, preserving protocol-range values without IEEE-754 rounding; counts are JSON-safe, non-negative
  integers. The SDK is responsible for safe decimal handling.
- `asOfLedger` is the minimum checkpoint of the identity/reputation data actually incorporated into this
  response's discovery projection revision. If a score materialized view refresh lags the raw event tables,
  its incorporated-ledger watermark wins; the API MUST NOT advertise the newer indexer checkpoint. It is not
  a claim that every Stellar contract is indexed to that ledger.
- `indexedAt` is when that effective projection watermark was finalized, not when the HTTP response was
  generated. `timestamp` is response generation time.
- `coverage.scope = indexed_projection` explicitly excludes unindexed chain state and unresolved external
  metadata.
- `coverage.queryComplete` is true only if the server evaluated the complete indexed projection for the
  filters/text without an internal candidate cap. v2 MUST fail with `503 QUERY_INCOMPLETE` rather than return
  a normal 200 with hidden truncation.
- A consumer that walks pages computes its old-style coverage as
  `coverageComplete = every(queryComplete) && final(hasMore === false)`. A single page with `hasMore: true`
  is not a complete MCP candidate scan.
- `score.normalized` is the upstream discovery-order value under `scoreVersion`; it is not silently relabeled
  as this MCP's client-side three-axis ranking score. The MCP may re-rank returned components under its own
  explicitly reported policy.

### Error response

Every error uses the same envelope and is `Cache-Control: no-store` unless an explicitly documented 429
policy says otherwise:

```json
{
  "success": false,
  "error": {
    "code": "CURSOR_STALE",
    "message": "Requested discovery revision is no longer available; restart from the first page.",
    "retryable": true
  },
  "meta": {
    "version": "2.0.0",
    "chain": "stellar",
    "network": "mainnet",
    "requestId": "01K...",
    "timestamp": "2026-07-29T12:35:01.000Z"
  }
}
```

| HTTP | Code | Consumer action |
|---:|---|---|
| 400 | `INVALID_QUERY`, `UNKNOWN_QUERY_PARAMETER`, `INVALID_CURSOR`, `CURSOR_QUERY_MISMATCH` | Fix request; do not retry unchanged |
| 410 | `CURSOR_EXPIRED` | Restart from page one |
| 409 | `CURSOR_STALE` | Revision was exceptionally evicted/reconciled before cursor expiry; restart with bounded retries |
| 422 | `UNSUPPORTED_NETWORK` | Select a deployed network/API explicitly |
| 429 | `RATE_LIMITED` | Honor `Retry-After` through the SDK |
| 503 | `INDEX_STALE`, `INDEX_INTEGRITY_DEGRADED`, `QUERY_INCOMPLETE`, `UPSTREAM_UNAVAILABLE` | Degrade honestly; never query Supabase directly |
| 503 | `INDEX_ROLLBACK_DETECTED` | Stop serving v2 until the projection is reconciled |

The MCP maps these into its stable tool error taxonomy. Soroban reputation evidence is a separate state:
indexed rows may still be returned with status `unavailable`, whether the RPC failed or the reachable client
page could not prove exhaustion, but no reputation field may be called verified.

### ETag and cache semantics

For a fresh, complete 200 response:

```http
Cache-Control: public, max-age=15, stale-while-revalidate=30
ETag: "discovery-v2:<projectionRevision>:<canonicalQueryHash>:<pageKey>"
```

- The ETag MUST cover the network, every normalized query parameter, cursor/page key, API/search/score
  versions, and `projectionRevision`.
- `If-None-Match` returns 304 only for the exact same logical page and revision.
- The upstream API owns cache headers; the public Cloudflare route and Service Binding MUST preserve them.
- Stale/integrity-degraded/partial responses and all errors are `no-store`.
- The MCP MAY keep a local cache only up to the upstream `max-age`. Its key includes network, API version,
  every normalized query argument, and cursor. A process-local cache is an optimization, never shared truth.
- A cache hit does not extend cursor expiry and cannot convert `hasMore: true` into complete coverage.

## Freshness, integrity, and replay behavior

The indexer's checkpoint behavior is part of the trust boundary:

- A partial fetch/write failure MUST leave the relevant checkpoint unadvanced so it can be retried. The API
  cannot advertise an `asOfLedger` beyond durably written projection state.
- Dead-lettered or otherwise skipped events that can affect discovery MUST make integrity degraded and cause
  v2 to return `503 INDEX_INTEGRITY_DEGRADED`, not a deceptively complete result.
- v2 considers the effective dependency stale after five minutes without checkpoint progress and returns
  `503 INDEX_STALE`. Consumers must inspect freshness metadata/error state; the current v1 health endpoint's
  top-level `status` alone is not sufficient to prove that each registry is advancing.
- Stellar does not use probabilistic-confirmation reorg handling like many proof-of-work chains, but replay,
  out-of-order events, operator rollback, and projection rebuilds still exist. Per-row ledger guards prevent
  older events from overwriting newer state.
- `asOfLedger` MUST be monotonic across newly finalized healthy generations. If it decreases, the API
  invalidates affected retained generations/cursors/ETags and fails closed with `INDEX_ROLLBACK_DETECTED`
  until reconciliation completes.
- If the Explorer API is down, the MCP may return a bounded still-fresh cache entry only when allowed by the
  original cache header; otherwise it returns an upstream error. There is no database bypass.
- If Soroban RPC is down, discovery can remain available from indexed truth while reputation evidence reports
  `unavailable`. A reachable RPC also remains `unavailable` until client-set exhaustion is provable. Indexed
  and verified are separate states.

## Backward compatibility and rollout

v2 is additive:

1. `/api/v1/agents` and `/api/v1/search` remain unchanged while existing SDK users migrate.
2. The upstream SDK adds a typed `discoverAgentsV2(params)` method and response/error types. It does not
   silently change `getAgents()` pagination or fields.
3. The SDK's injectable `fetch` path is tested once against public HTTP and once against a Service Binding;
   both paths run the same request/normalization code.
4. This MCP adds a feature-gated v2 adapter. In shadow mode it compares IDs, order, pagination, and filters
   against v1 without changing user-visible results.
5. On v2 failure, a temporary v1 fallback is allowed only when its bounded nature remains explicit:
   `coverageComplete: false`, the original `pagesScanned`/`recordsScanned`/`hasMore`, and a source marker such
   as `discoveryApi: "v1-fallback"`. It never falls back to Supabase.
6. v2 becomes the default only after filter/cursor/cache contract tests pass, public and binding canaries
   agree, freshness/integrity alerts are live, and shadow comparison has no unexplained membership loss.
7. v1 deprecation requires a published SDK migration path and observed v2 adoption; removing it is a separate
   versioned decision, not part of this proposal.

The upstream Worker route must explicitly allow `/api/v2/discovery`; a Service Binding must not become an
unreviewed path around the public endpoint allowlist.

## Observability and operational gates

One request/trace ID SHOULD cross MCP, Service Binding/public HTTP, upstream Worker, and API logs. Log structured
fields, not raw agent metadata or credentials:

- API/search/score version, network, normalized boolean/trust filters, text length plus a one-way query hash,
  sort, limit, and cursor presence;
- request ID, `projectionRevision`, `asOfLedger`, indexed age, cache outcome, status/error code;
- database duration and row count, but not raw free text, service-role keys, agent secrets, or full metadata;
- SDK attempt/retry/rate-limit latency; and
- MCP v2/v1-fallback selection plus Soroban verification status/latency.

Minimum rollout dashboards/alerts cover p50/p95/p99 latency, 4xx/429/5xx rate, cursor-stale restart rate,
query-incomplete count, indexed ledger/time lag, integrity degradation, Cloudflare cache hit rate, SDK retry
rate, v1 fallback rate, and public-vs-binding shadow mismatches.

## Change ownership

| Change | Owning repo |
|---|---|
| Supabase migration/view/RPC, indexer watermark/integrity state, `/api/v2/discovery`, Worker allowlist | `trionlabs/stellar-8004` |
| SDK v2 types/method, cursor/error normalization, injected-fetch parity tests | `trionlabs/stellar-8004` |
| Constant-cost complete reputation aggregate + generated bindings | `trionlabs/stellar-8004` ([#19](https://github.com/trionlabs/stellar-8004/issues/19)) |
| Preserve service `description` / `inputExample` in a post-0.0.11 SDK release | `trionlabs/stellar-8004` ([#20](https://github.com/trionlabs/stellar-8004/issues/20)) |
| MCP v2 adapter, coverage mapping, v1 fallback label, ranking/verification integration | this repo |
| Remote MCP Worker and Service Binding wiring | this repo, with the upstream Worker binding configured by its owner |

No upstream code is vendored here. Discovery remains gated by
[upstream issue #18](https://github.com/trionlabs/stellar-8004/issues/18), complete bounded reputation by
[#19](https://github.com/trionlabs/stellar-8004/issues/19), and service-field preservation by
[#20](https://github.com/trionlabs/stellar-8004/issues/20). Until #18 or a resulting ADR is accepted, the full
consumer discovery contract is tracked in [P3-13](../issues/P3-13-upstream-discovery-api-v2.md). The upstream repo has contribution
mechanics, but no checked-in backlog index or API/architecture proposal acceptance gate was found; keeping the
proposal here prevents a cross-repo dependency from becoming invisible. Retain this document as the
MCP-side contract mirror and update it when upstream decisions change the accepted contract.

## Implementation references

Current consumer sources:

- [`ExplorerService`](../src/lib/explorer.ts)
- [`find_agent`](../src/tools/find_agent.ts)
- [`rank_agent`](../src/tools/rank_agent.ts)
- [`list_services`](../src/tools/list_services.ts)
- [Architecture and current coverage note](architecture.md#explorer-access-notes-libexplorerts)

Upstream implementation inspected at commit
[`d92c2f4`](https://github.com/trionlabs/stellar-8004/tree/d92c2f4ee01858b6da9bf4404ac49322c324958b):

- [Explorer SDK client](https://github.com/trionlabs/stellar-8004/blob/d92c2f4ee01858b6da9bf4404ac49322c324958b/webapp/packages/sdk/src/api/explorer.ts)
- [v1 agent handler](https://github.com/trionlabs/stellar-8004/blob/d92c2f4ee01858b6da9bf4404ac49322c324958b/webapp/supabase/functions/api/handlers/agents.ts)
- [v1 search handler](https://github.com/trionlabs/stellar-8004/blob/d92c2f4ee01858b6da9bf4404ac49322c324958b/webapp/supabase/functions/api/handlers/search.ts)
- [API response/cache boundary](https://github.com/trionlabs/stellar-8004/blob/d92c2f4ee01858b6da9bf4404ac49322c324958b/webapp/supabase/functions/api/lib/response.ts)
- [Indexer health handler](https://github.com/trionlabs/stellar-8004/blob/d92c2f4ee01858b6da9bf4404ac49322c324958b/webapp/supabase/functions/api/handlers/health.ts)
- [Cloudflare Worker configuration](https://github.com/trionlabs/stellar-8004/blob/d92c2f4ee01858b6da9bf4404ac49322c324958b/webapp/apps/web/wrangler.toml)
