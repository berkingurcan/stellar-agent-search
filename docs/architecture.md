# Architecture

`stellar-agent-mcp` is a single TypeScript (ESM, NodeNext) binary that is **both** an MCP stdio server and a
human CLI, built on the stable MCP **1.x** SDK. It is read-only and keyless. This document covers the data
flow, the ranking formula, the verification overlay, the trust model, and the delivery/spec stance.

## System overview

```
MCP client (Claude Code / Cursor / Windsurf / Cline / VS Code)   +   human terminal
        │  stdio (stdout = JSON-RPC only · stderr = logs)             │  TTY subcommands
        ▼                                                             ▼
  stellar-agent-mcp  (ONE bin: src/index.ts dispatches → mcp server | cli | doctor | serve)
        │
        ├─ buildServer(config)  →  Tools · Resources (stellar8004://…) · Prompts
        │        capabilities: { tools, resources, prompts }   (no listChanged — stateless)
        │
        ├─ ExplorerService     (stellar-8004 HTTP API)      [PRIMARY DATA]
        │        └─► https://stellar8004.com
        │
        └─ ReputationVerifier  (Soroban RPC, bounded top-K) [VERIFY: declared → verified]
                 └─► https://mainnet.sorobanrpc.com  →  Reputation contract (get_summary + get_clients_paginated)

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
ranking. `serve --http` (Streamable HTTP) is a documented post-`v0.1.0` stretch and is **not** enabled in
this build.

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

The identifiers surface both the identity-network form and the CAIP-2 form so any A2A/AP2 consumer can read
them; `get_agent_profile` also emits an **A2A AgentCard projection** (with an `x-stellar8004` verified
extension) inside a labeled self-declared slot.

## The 3-axis ranking engine (`lib/ranking.ts`)

Deterministic and **pure**: identical inputs (with an explicit `now` for the freshness flag) yield
byte-identical output. Three orthogonal axes, each normalized to `[0, 1]`:

```
quality = clamp(avg / RANK_SCORE_MAX, 0, 1)              # null/0 when unrated
volume  = clamp(ln(1+feedbackCount)  / ln(1+50), 0, 1)   # log-saturating
breadth = clamp(ln(1+uniqueClients)  / ln(1+25), 0, 1)   # sybil-resistant
```

Weighted base + additive bonuses:

```
base  = wQ·quality + wV·volume + wB·breadth              # default weights 0.5 / 0.2 / 0.3 (sum 1 ⇒ [0,1])
score = clamp(base + paymentBonus + endpointBonus + verifiedBonus, 0, 1)
score100 = round(score · 100)                            # the displayed 0..100 score
```

Bonuses (already scaled into the `[0,1]` score space): x402 **+0.05**, mpp **+0.03**, hasServices **+0.03**,
on-chain-**verified** **+0.03**. Weights are env-overridable (`RANK_W_*`) or per-call (`rank_agent.weights`),
always re-normalized to sum 1.

**Why breadth > volume:** unique clients (breadth) are hard to fake; raw feedback count (volume) is cheap to
fake. Weighting breadth above volume is the ranking's sybil hedge.

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
| `verified` | on-chain summary matched declared within tolerance |
| `mismatch` | declared and on-chain diverged beyond tolerance (flag only, no penalty) |
| `unavailable` | verification attempted but the RPC was down / the simulation was rejected |
| `skipped` | not attempted (disabled via `VERIFY_ONCHAIN=false`/`--no-verify`, or outside the top-K) |

Verification is **bounded**: only the top-K returned rows are verified (default K = 5 for discovery; up to
the request `limit`, capped at 25, for explicit `rank_agent`). It **degrades closed** — if the RPC fails,
the row falls back to declared-only with `status: "unavailable"` rather than erroring the whole call.

## Explorer access notes (`lib/explorer.ts`)

- The explorer's `/search` substring-matches poorly and offers **no server-side score sort** (only
  `created_at` / `id`). Discovery therefore uses `getAgents({search})` + **client-side filtering**, and all
  ranking is done **client-side** over fetched pages.
- List walks are **hard page-capped** (never an unbounded loop on a hostile `pagination.total`).
- The service layer uses a TTL cache + single-flight and the SDK's 429/backoff handling.

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

This server verifies **provenance, liveness, and on-chain reputation re-derivation**, and the demo grounds
feedback with a payment tx hash + result hash. It does **not** solve **Sybil resistance / proof-of-personhood**;
`uniqueClients` (breadth) is a thin hedge, not a solution. That is a deliberate, stated limit, not an
oversight.

## Multi-chain readiness

Identifiers carry a CAIP-2 namespace and the data layer is reached only through a service abstraction
(`ExplorerService` today), so an EVM-8004 adapter would be **additive, not a rewrite**. v0.1 ships
**Stellar-only**; the tool schemas are kept chain-aware so a future adapter is non-breaking.

## Delivery & spec stance

- **Transport:** stdio, primary and default — correct for a keyless, read-only, local server. SSE is
  deprecated and is **not** shipped. A stateless Streamable HTTP variant is a documented stretch.
- **SDK / spec:** built on the stable `@modelcontextprotocol/sdk` **1.29.0** (spec **2025-11-25**),
  `McpServer` + `registerTool`/`registerResource`/`registerPrompt` + `StdioServerTransport`, zod v3 input
  schemas. A keyless read-only stdio server needs none of the 2026 RC's heavy machinery (Tasks, Apps,
  stateless-HTTP, OAuth hardening); the RC's logging-to-stderr direction is already how this server behaves.
  Migration to the v2 SDK is trivial (`registerTool` already exists) and scheduled as post-`v0.1.0`
  maintenance.
- **Schema safety:** output schemas keep any `oneOf`/`anyOf`/`allOf` **inside** `properties`, never at the
  schema root (Claude Code rejects root-level combinators).
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
