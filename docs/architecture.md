# Architecture

`stellar-agent-mcp` has one shared TypeScript service/tool layer with two adapters: a Node (ESM, NodeNext)
binary that is both an MCP stdio server and a human CLI, and a separate stateless Cloudflare Worker. The
runtime uses the split MCP v2 packages (`@modelcontextprotocol/server` and `@modelcontextprotocol/client`
2.0.0) with Zod 4 and requires Node ≥ 20 for the local binary. Both adapters are read-only and keyless.

The local stdio path is usable now. The Worker implementation exists, but its public route is **not deployed**;
`https://mcp.stellar8004.com/mcp` currently returns the landing site's 404. This document distinguishes
implemented code from live, canary-proven behavior.

## System overview

```
LOCAL — available now

MCP client (Claude Code / Cursor / Windsurf / Cline / VS Code)   +   human terminal
        │  stdio (stdout = JSON-RPC only · stderr = logs)             │  TTY subcommands
        ▼                                                             ▼
  stellar-agent-mcp  (src/index.ts dispatches → MCP server | CLI | doctor | setup)
        │
        └─ buildServer(config) → Tools · Resources (stellar8004://…) · Prompts
                 │
                 ├─ ExplorerService ──HTTPS──► stellar8004 public API [PRIMARY DATA]
                 └─ ReputationVerifier ──► Soroban RPC ──► Reputation contract

REMOTE — implemented, not deployed

Remote MCP client ──POST /mcp──► Cloudflare runtime Worker
                                      │  fresh MCP server per request; no sessions
                                      ├─ ExplorerService ──Service Binding──► stellar8004-web
                                      │                                      └─ canonical Supabase-backed index
                                      └─ ReputationVerifier ──HTTPS──► Soroban RPC

  examples/x402-demo.ts  (SEPARATE process, SOLE keyed actor) — never an MCP tool
```

**Data precedence, everywhere:** explorer (primary) → on-chain verify (overlay) → **degrade closed** to
declared-only when the RPC is down or verification is disabled. The tools and the resources emit the **same**
canonical `AgentProfile` join (defined once in `src/types.ts`) so they never diverge.

## Dual CLI + MCP dispatch

`src/index.ts` selects a mode from argv and stdin (`src/cli/index.ts` implements both):

| Invocation | Result |
|---|---|
| no args, stdin **not** a TTY (how clients launch us) | MCP stdio server |
| no args, stdin **is** a TTY | friendly help + hint |
| `mcp` / `serve` / `--stdio` | explicit MCP stdio server |
| `find` / `rank` / `profile` / `services` / `doctor` | human CLI subcommand |
| `--help` / `--version` | help / version |

Both modes go through the **same** service layer (`ExplorerService` + `ReputationVerifier` + the ranking
engine), so the CLI is a thin formatter over the exact logic the tools call — no duplicated discovery or
ranking. `serve` remains an alias for the local stdio server; it does not open an HTTP listener. Streamable
HTTP lives in `worker/` as a separately built and deployed Cloudflare adapter.

## Module layout (`src/`)

| Path | Owns |
|---|---|
| `index.ts` | bin entry + dual-mode dispatch |
| `server.ts` | `buildServer(config)` — the MCP server factory, capabilities, `instructions` string |
| `config.ts` | env → typed `Config` (network, contracts, RPC, weights); ignores `STELLAR_PRIVATE_KEY` |
| `types.ts` | **frozen** shared contracts (`AgentProfile`, `RankResult`, `VerificationResult`, …) |
| `tools/` | the read-only tool surface (one file per tool) + `shared.ts` (deps, adapters, rank+verify pipeline) |
| `resources/` | the `stellar8004://` resource layer (dual JSON + markdown) |
| `prompts/` | the slash-command workflow prompts |
| `cli/` | the human CLI (`find`/`rank`/`profile`/`services`/`doctor`) + stdio server bootstrap |
| `lib/` | `explorer` · `reputation` · `ranking` · `identifier` · `agentcard` · `sanitize` · `nlparse` · `errors` · `logger` · `clock` |
| `../worker/` | Cloudflare Streamable HTTP adapter, edge admission controls, Service Binding egress, and Worker-specific tests/config |

## Canonical data: `AgentProfile`

The cross-registry join produced for one agent (`src/types.ts`):

- **Verified / typed identity** — `id`, `stellarId` (`stellar:{network}:{identity}#{id}`), `caip2Id`
  (`stellar:{pubnet|testnet}:…` for the x402/MPP layer), `network`, `owner`, `wallet`, `agentUri`.
- **Capabilities** — `x402`, `mpp`, `hasServices`, `supportedTrust[]`.
- **Reputation** — `scores` (declared) + `verification` (declared-vs-on-chain) + `verified` (convenience
  boolean).
- **Rank** — the full `RankResult` breakdown + `flags`.
- **Provenance** — `createdAt`, `txHash`, `resolveStatus`.
- **`selfDeclared`** — the **only** slot holding untrusted agent free text (name/description/image/
  services/metadata), sanitized and bounded.

The identifiers surface both the identity-network form and the CAIP-2 form. `get_agent_profile` also emits an
explicitly **unverified, derived A2A-shaped projection** inside a labeled self-declared slot. It does not fetch
an agent-published card, promote registry endpoints into invokable A2A URLs, synthesize payment requirements,
or claim protocol/endpoint conformance. Its `x-stellar8004.verified` flag is scoped to reputation-summary
re-derivation only.

## The 3-axis ranking engine (`lib/ranking.ts`)

Deterministic and **pure**: identical inputs (with an explicit `now` for the freshness flag) yield
byte-identical output. Three orthogonal axes, each normalized to `[0, 1]`:

```
quality = clamp(avg / RANK_SCORE_MAX, 0, 1)              # null/0 when unrated
volume  = clamp(ln(1+feedbackCount)  / ln(1+50), 0, 1)   # log-saturating
breadth = clamp(ln(1+uniqueClients)  / ln(1+25), 0, 1)   # Sybil-cost-aware heuristic
```

Weighted base + additive bonuses:

```
base  = wQ·quality + wV·volume + wB·breadth              # default weights 0.5 / 0.2 / 0.3 (sum 1 ⇒ [0,1])
score = clamp(base + paymentBonus + endpointBonus, 0, 1)
score100 = round(score · 100)                            # the displayed 0..100 score
```

Bonuses (already scaled into the `[0,1]` score space): x402 **+0.05**, mpp **+0.03**, and hasServices
**+0.03**. Verification evidence never changes the score; the retained `verifiedBonus` response field is
always `0` for pre-release schema continuity. Weights are env-overridable (`RANK_W_*`) or per-call
(`rank_agent.weights`), always re-normalized to sum 1.

**Why breadth > volume:** unique clients (breadth) are hard to fake; raw feedback count (volume) is cheap to
fake. Weighting breadth above volume is a Sybil-cost hedge, not Sybil-resistance or proof of personhood.

**Two separated scores:** the displayed `score` is honest (an unrated agent contributes 0 on quality and is
flagged `unrated`), while an ordering-only `sortScore` applies a `0.15` novelty floor so a capable-but-unrated
agent is *ordered, not buried* — without inflating its shown score.

**Flags:** `unrated` (feedbackCount 0), `newAgent` (created < 14 days), `lowConfidence` (< 3 feedback),
`verified`, `verificationMismatch`. A `mismatch` is a flag with **no score penalty**. `confidence` is a
separate evidence proxy (`0.6·volume + 0.4·breadth`), independent of quality.

**Sorting** (`sortBy`): `relevance` (sortScore) · `score` · `confidence` · `newest`. Ties break by confidence
desc, then id asc — fully deterministic.

## The verification overlay (`lib/reputation.ts`)

`ReputationVerifier.verifyAgainst(id, declared)` re-derives reputation directly from the on-chain Reputation
contract (`get_clients_paginated` + `get_summary`, via Soroban simulation) and diffs it against the
explorer's declared numbers, producing a `VerificationResult`:

| `status` | Meaning |
|---|---|
| `verified` | reserved for a future comparison that covers every declared reputation field |
| `partial` | bounded on-chain average and active-count comparison matched; active unique clients remain unverified |
| `mismatch` | a compared field diverged beyond tolerance; unversioned snapshots mean this is not proof of manipulation |
| `unavailable` | comparison attempted but the RPC failed, the client set exceeded the five-client cap, or the simulation was rejected |
| `skipped` | not attempted (disabled via `VERIFY_ONCHAIN=false`/`--no-verify`, or outside the top-K) |

Comparison is **bounded twice**: only the top-K returned rows are checked, and the current contract summary is
usable only when the complete comparable client set is at most five. The explorer and RPC also lack a shared
ledger-bound snapshot. Healthy current results are therefore `partial`, never full `verified`. The path
**degrades closed** — if completeness or RPC evidence is missing, the row falls back to declared-only with
`status: "unavailable"` rather than erroring the whole call or manufacturing certainty.

## Explorer access notes (`lib/explorer.ts`)

- The existing stellar8004 registry/indexer and its Supabase database remain the **canonical projection**.
  The MCP project does not run a shadow indexer or copy that database. In the local adapter, ExplorerService
  calls the public API; in the Worker adapter, it calls the same `stellar8004-web` service through a Service
  Binding. The Worker has no Supabase URL or service-role credential.
- The explorer's `/search` substring-matches poorly and offers **no server-side score sort** (only
  `created_at` / `id`). Discovery therefore sends structured filters to `getAgents`, then performs text
  matching and ranking **client-side** over a bounded candidate window.
- List walks are **hard page-capped** (never an unbounded loop on a hostile `pagination.total`).
- Discovery tools return `coverageComplete`, `pagesScanned`, `recordsScanned`, and `hasMore` when known, so a
  bounded window cannot be mistaken for a global result. A server-side cursor discovery API remains the
  production-scale fix.
- The service layer uses a TTL cache + single-flight and the SDK's 429/backoff handling.

The scale fix belongs upstream, not in another database here. The proposed cursor-based discovery contract,
freshness metadata, stable ordering, and ownership boundary are in
**[stellar8004-integration.md](stellar8004-integration.md)** and
[trionlabs/stellar-8004#18](https://github.com/trionlabs/stellar-8004/issues/18). Issue #18 is a proposal, not
an accepted or deployed API; until it lands, coverage fields are the honesty boundary for bounded scans.

## Remote Cloudflare adapter (implemented, not live)

### Routing and lifecycle

The public hostname is deliberately split between two independently deployable Workers:

- `stellar-agent-mcp-web` is an assets-only Worker and owns the `mcp.stellar8004.com` custom domain.
- `stellar-agent-mcp` is the runtime Worker. Exact zone routes for `/mcp` and `/healthz` are more specific
  than the custom-domain origin and therefore direct only those paths to the runtime.
- `workers.dev` and preview URLs are disabled, so they cannot bypass the canonical hostname policy.

The landing Worker must be deployed first because it establishes the proxied hostname. The runtime route is
not deployed today: `/mcp` still reaches the landing Worker and returns 404. The code therefore makes no live
availability, interoperability, latency, or protocol-conformance claim yet.

The published/local Node binary supports Node ≥ 20. The Worker build/deploy workspace currently declares
Node ≥ 22.18 for its Agents/Wrangler development toolchain; this is a contributor/CI requirement, not a
requirement imposed on remote MCP clients.

For each accepted `/mcp` request, Cloudflare Agents `0.20.1` calls `createMcpHandler`, constructs a **fresh**
v2 server through `buildServer(config, { deps })`, and discards it after the response. The handler uses
automatic response mode plus a stateless legacy compatibility lane; there are no sessions, Durable Objects,
resume tokens, or server-initiated notifications. The target for modern Streamable HTTP clients is MCP
`2026-07-28`: that lane starts with `server/discover` and carries a per-request `_meta` envelope; it does
**not** use legacy `initialize`. The compatibility lane does accept legacy stateless `initialize`. By
contrast, the currently tested local stdio negotiation reports `2025-11-25`. Those dates describe transport
negotiations, not different tool contracts.

`/healthz` is intentionally shallow: it reports only that the Worker can execute and makes no upstream call.
It must not be described as registry, Service Binding, Supabase, or Soroban health.

### Request admission and egress boundary

The remote endpoint is deliberately **public and unauthenticated** because its tools are read-only and expose
public registry/on-chain data. That is not the same as being unguarded:

- Only the canonical production host and explicit local-development hosts are accepted. Browser `Origin`
  values are allowlisted; originless non-browser clients are allowed. **CORS is a browser control, not
  authentication.**
- `/mcp` accepts `POST` (plus CORS `OPTIONS`) only, requires JSON, streams at most 256 KiB, caps JSON-RPC
  batches at 8, and rejects requests whose conservative estimated upstream cost exceeds 24.
- The cost budget exists because Cloudflare caps a Worker invocation chain at 32. It estimates worst-case
  calls to the bound `stellar8004-web` Worker before constructing the server. Soroban verification RPC is
  separately bounded and cached; it is not charged to this Service Binding counter. The estimate is an
  admission heuristic, not exact billing or proof that a dependency can never change its call pattern.
- A keyed rate-limit binding debits an IP + user-agent hash, weighted by estimated cost, at a configured
  30 units/minute. Cloudflare's limiter is PoP-local and approximate, and limiter failure currently fails
  open. It is best-effort abuse friction — **not** a global quota, authorization check, fairness guarantee, or
  accounting boundary. A caller can rotate user-agent values to fragment its bucket, while unrelated users
  behind the same NAT and user-agent can share one; durable principal-level quotas would require an identity
  layer such as OAuth.
- Explorer egress accepts only `GET` to the configured base's `/api/v1` or `/api/v2` paths, rewrites that
  request to `STELLAR8004_API`, and strips caller `Authorization`, `Cookie`, MCP, forwarding, and arbitrary
  headers. It forwards only a bounded `Accept`; when Cloudflare supplied a syntactically valid
  `cf-connecting-ip`, both downstream `cf-connecting-ip` and `x-real-ip` are derived from that edge-owned
  value. Caller-provided `x-real-ip` and `x-forwarded-for` are never trusted. Agent-declared service endpoints
  are never fetched.

There is one unresolved production proof. The upstream Svelte adapter currently derives its client address
from `cf-connecting-ip`, and the reconstructed bodyless Service Binding `GET` derives both relevant headers
only from Cloudflare's edge-owned incoming value. Unit tests prove that transformation, but cannot prove the
full deployed edge → runtime Worker → Service Binding → `stellar8004-web` path. Deploy remains blocked until
a two-client live canary shows distinct upstream identities; silently collapsing all callers onto one quota
would let one busy client degrade the registry for everyone.

### Cache boundaries

Explorer data gets two actor-neutral, best-effort cache layers in the Worker:

1. A shared isolate-local `TtlCache` (bounded to 500 entries per network/base tuple) is injected into each
   fresh server's ExplorerService. It reduces repeat work but is lost on isolate eviction and is not global.
2. When `caches.default` exists, the Service Binding adapter reads/writes Cloudflare Cache API entries only
   for upstream `200` responses that explicitly declare `Cache-Control: public`, do not set cookies, and do
   not vary on authorization or cookies. Actor-specific `x-ratelimit-*` headers are removed before a shared
   entry is written. Cache API availability and entries are PoP-local/best effort.

A separate bounded isolate-local verifier cache (200 entries per network/RPC tuple) reuses Soroban reputation
reads across fresh per-request servers. It is also evictable and best effort. None of these caches is a
correctness source, global freshness guarantee, authorization boundary, billing ledger, or replacement for
the canonical index. Soroban verification still provides the bounded declared-vs-on-chain overlay; cache
reuse does not upgrade declared data to verified data.

### Deployment gates

Two explicit gates keep the implemented Worker from being mistaken for production-ready:

1. `worker/wrangler.jsonc` contains rate-limit namespace `0`, a dry-run sentinel; the deploy script refuses
   to publish until it is replaced with an account-unique namespace.
2. After a controlled deploy, a live canary must verify original caller identity through the Service Binding,
   Host/Origin behavior, modern `server/discover`, legacy `initialize`, tool listing, bounded tool calls,
   cache headers, and rollback of the two exact routes.

Until both pass, documentation and client examples must continue to recommend local stdio.

## Error taxonomy (`lib/errors.ts`)

SDK/data errors are mapped to `isError: true` tool results with a **stable** `code` — part of the tool
contract. Zod input-validation errors are handled by the MCP SDK before the handler runs.

| SDK error | `code` | Extra |
|---|---|---|
| `RateLimitError` | `RATE_LIMITED` | `retryAfterMs` |
| `NotFoundError` | `NOT_FOUND` | — |
| `ValidationError` | `BAD_REQUEST` | — |
| `ApiError` | `UPSTREAM_ERROR` | `detail: status=…` |
| other `Error` | `INTERNAL` | — |

## Trust model (summary)

The registry is permissionless → all agent-authored text is untrusted. Server-authored output interpolates
only typed values (compile-time-enforced by the `serverText` tagged template); untrusted text lives only in
labeled, sanitized `selfDeclared` slots. Full threat model, the sanitization caps, and the prompt-injection
posture are in **[../SECURITY.md](../SECURITY.md)**.

### Honest limits

This server verifies registry/transaction provenance and re-derives bounded reputation reads on-chain. It
does **not** probe or verify agent service-endpoint liveness or protocol conformance. The demo is designed to
bind completed feedback to validated payment transaction and result hashes, but its first funded, recorded
mainnet run is still pending. It also does **not** solve **Sybil resistance / proof-of-personhood**;
`uniqueClients` (breadth) is a thin hedge, not a solution.

## Multi-chain readiness

Identifiers carry a CAIP-2 namespace and the data layer is reached only through a service abstraction
(`ExplorerService` today), so an EVM-8004 adapter would be **additive, not a rewrite**. v0.1 ships
**Stellar-only**; the tool schemas are kept chain-aware so a future adapter is non-breaking.

## Delivery & spec stance

- **Local transport:** stdio remains the primary, deploy-independent default. The split MCP v2 server/client
  packages are pinned at `2.0.0`; the real local handshake currently negotiates protocol `2025-11-25` over
  `StdioServerTransport`. `serve` means stdio, not an HTTP listener. SSE is not shipped.
- **Remote transport:** the separate Cloudflare Worker uses Agents `0.20.1` `createMcpHandler`, fresh server
  factories, automatic response mode, and a stateless legacy lane. Its modern target is MCP `2026-07-28` at
  `/mcp`. The implementation and tests exist, but the route is not live and no production conformance claim
  is made before the canary.
- **Schemas:** tools, resources, and prompts register through the v2 package with Zod 4 objects. Output
  schemas keep any `oneOf`/`anyOf`/`allOf` **inside** `properties`, never at the schema root (some clients
  reject root-level combinators).
- **Tool-search legibility:** the server ships a crisp `instructions` string ("Start with find_agent") so a
  tool-search client knows when to reach for the server before loading individual tool schemas.

## Runtime facts (mainnet)

| | |
|---|---|
| Network default | `mainnet` |
| Explorer | `https://stellar8004.com` |
| Soroban RPC | `https://mainnet.sorobanrpc.com` |
| Identity contract | `CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35` |
| Reputation contract | `CBOIAIMMWAXI57OATLX6BWVDQLCC4YU55HV6MZXFRP6CBSGAMXSTEPPA` |
| Validation contract | `CBT6WWEVEPT2UFGFGVJJ7ELYGLQAGRYSVGDTGMCJTRWXOH27MWUO7UJG` |

Contract addresses, RPC URL, and the network passphrase are reused from `@trionlabs/stellar8004`'s
`getConfig()` / `MAINNET_CONFIG` — never re-derived here.

---

## Transport & runtime portability

Recorded from a spike, so the constraints are not re-discovered later.

### The axios coupling

`@trionlabs/stellar8004` imports the default `@stellar/stellar-sdk` build, whose RPC transport is **axios**.
axios below 1.16.1 issues a plain-HTTP (non-`CONNECT`) request for an `https://` URL when a proxy is configured;
proxies answer that with **405**. The visible symptom is on-chain verification reporting `unavailable` while the
explorer and RPC health checks pass — exactly the feature this server exists for, silently degraded.

`doctor` surfaces this rather than hiding it:

```
✗ verify    on-chain read FAILED (rpc-error): Request failed with status code 405
```

### The fix: reads run on the fetch-based build

`src/lib/soroban.ts` builds the Reputation reader from `@stellar/stellar-sdk/no-axios/contract`, whose
`Client` internally requires `../rpc` — so the whole chain is fetch. It does not re-implement the contract ABI:
it borrows the generated bindings' `Spec` and hands it to the no-axios `Client`, so encoding and decoding stay
byte-identical and there is no second copy of the ABI to go stale.

One trap, found the hard way and now pinned by a test. The bindings' `Client` constructor **mutates the options
object it is given**, writing back an axios-backed `rpc.Server` under `options.server`; the no-axios `Client`
then honours a pre-set `options.server`. Sharing one options object between the spec donor and the real client
silently reinstates axios for every read — it typechecks, it passes offline tests, and it fails only against a
live proxy. Each client gets its own freshly built options.

Verified end to end: with the `overrides` block removed and the vulnerable `axios@1.15.0` restored, `doctor`'s
on-chain verification passes through the same proxy that produced the `405` above.

**What this does not do.** `@trionlabs/stellar8004` is a barrel — importing anything from it (including
`getConfig` in `src/config.ts`) loads the default SDK build and therefore axios into the process, even though
nothing on the read path uses it. The package also still appears in a consumer's `npm audit`, which is static.
Closing that needs either the upstream range widened or every barrel import moved to a subpath
(`@trionlabs/stellar8004/api/explorer` is axios-free; `/bindings` is not).

### The `overrides` fix — and exactly how far it reaches

`@stellar/stellar-sdk@15.1.0` pins axios to the **exact** version `1.15.0`, so there is no range to widen. An
npm `overrides` block forces a patched axios into the tree instead:

```json
"overrides": { "axios": "1.18.1" }
```

This is load-bearing twice over. It clears the two **high**-severity axios advisories that `npm audit` reports
against the 1.15.0 pin, and because 1.18.1 is past the 1.16.1 proxy fix it also makes the on-chain read work
through a proxy — `doctor` goes from the 405 above to all-green, returning agent 10's real figures.

**It does not reach end users.** npm honours `overrides` only from the *root* project, so a consumer who runs
`npx -y stellar-agent-mcp` resolves our dependencies fresh and gets `@stellar/stellar-sdk@15.1.0 → axios@1.15.0`
again. Verified by packing the tarball and installing it into a clean project. So the override protects this
repository, its CI, and anyone who clones it — not the published artifact.

The root cause is upstream: `@trionlabs/stellar8004@0.0.11` depends on `@stellar/stellar-sdk: ^15.0.0`
(`webapp/packages/sdk/package.json` in `trionlabs/stellar-8004`), so even bumping our own direct dependency to
`^16` just installs 15 again underneath it. Widening that range upstream, or one of the three options below, is
what actually fixes the published package.

### `no-axios` — verified working

The Stellar SDK ships a parallel fetch-based build under `@stellar/stellar-sdk/no-axios`, with matching
`/no-axios/rpc` and `/no-axios/contract` subpaths. Confirmed against mainnet from inside a proxied environment
where the axios path returns 405: it completes the same two reads and returns agent 10's four real client
addresses.

Aliasing works too. Bundling `@trionlabs/stellar8004` with

```
--alias:@stellar/stellar-sdk=@stellar/stellar-sdk/no-axios
--alias:@stellar/stellar-sdk/contract=@stellar/stellar-sdk/no-axios/contract
--alias:@stellar/stellar-sdk/rpc=@stellar/stellar-sdk/no-axios/rpc
```

produces a bundle with 144 `lib/no-axios/` modules and **zero** axios modules, and its `ReputationClient` reads
succeed through the proxy. Every subpath the SDK imports must be aliased; a missed one quietly restores the
axios build for that module.

### Why the npm artifact is not fixed by that alias

**tsup externalizes runtime dependencies.** `dist/index.js` imports `@trionlabs/stellar8004` and the split MCP
v2 server package rather than inlining them, so a build-time alias never reaches the published Node package.
The sourcemap contains no bundled `stellar-sdk` modules.

Closing it therefore needs a deliberate choice, not a config tweak:

| Option | Effect | Cost |
|---|---|---|
| `noExternal` the Stellar deps + alias | One self-contained artifact, fetch-only, no axios | Much larger tarball; dependency tree harder to audit |
| Call the Reputation contract directly via `no-axios/rpc` | Fixes the one path that matters; no bundling change | ~40 lines of contract-call code we own instead of the SDK's |
| Upstream `no-axios` support in `@trionlabs/stellar8004` | Cleanest | Not in our control |

### Consequence for edge runtimes

Cloudflare Workers must bundle, so `worker/wrangler.jsonc` aliases the default Stellar SDK plus its
`/contract` and `/rpc` subpaths to the `no-axios` build. Missing any one alias can silently restore axios for
that module. The Worker uses `nodejs_compat` for the small remaining Node-compatible surface.

Transport wiring is now implemented in `worker/src/index.ts`; the remaining work is operational proof, not a
service-layer redesign. The dry-run bundle and offline tests cannot prove zone routing, the real Service
Binding's caller identity, PoP-local rate-limit behavior, cache behavior, or interoperability with production
clients. Those are precisely the deployment canary gates described above.
