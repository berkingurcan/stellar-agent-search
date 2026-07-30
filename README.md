# stellar-agent-search

[![CI](https://github.com/berkingurcan/stellar-agent-search/actions/workflows/ci.yml/badge.svg)](https://github.com/berkingurcan/stellar-agent-search/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/stellar-agent-search.svg)](https://www.npmjs.com/package/stellar-agent-search)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-SDK%20v2-6E56CF.svg)](https://modelcontextprotocol.io)

> **A read-only ERC-8004 discovery layer that keeps indexed reputation declared and reports the exact limits of its bounded Stellar contract probe. The funded x402 + feedback proof is implemented but still pending its first recorded mainnet run.**

> **Pre-release security gate (29 July 2026):** the `stellar-agent-search` npm name is still unclaimed. Do not
> run the `npx` commands below until the [official npm page](https://www.npmjs.com/package/stellar-agent-search)
> shows a release owned by this project. Once installed, `setup` pins the exact package version in persistent
> MCP client configuration rather than executing a mutable `latest` tag on every launch.

There are two official interfaces, not two copies of the stack. TypeScript applications, registration, and
signed writes use the canonical [`@trionlabs/stellar8004`](https://www.npmjs.com/package/@trionlabs/stellar8004)
SDK from `trionlabs/stellar-8004`; MCP clients and terminal discovery use this package, which exact-pins that
SDK internally. The upstream repo's restricted Supabase Studio `/mcp` is database-operator tooling behind
SSH/IP controls, not an agent-registry MCP and must never be exposed as this runtime. See
[the integration boundary](docs/stellar8004-integration.md).

A **read-only, keyless** MCP server (and human CLI) that lets an AI agent — or you — **discover, rank, and
vet on-chain [stellar-8004](https://stellar8004.com) agents** on Stellar mainnet, then prepare an x402
(USDC pay-per-call) payment. One binary speaks the [Model Context Protocol](https://modelcontextprotocol.io)
over stdio to Claude Code / Cursor / Windsurf / Cline / VS Code, and doubles as a plain-terminal tool. A
separate Cloudflare Worker implementation exposes the same surface over stateless Streamable HTTP, but that
remote endpoint is **not live yet**; use the local stdio transport until its deployment canary passes.

```bash
npx -y stellar-agent-search@0.1.0 find "a paid web scraper with a good reputation"
```

---

## Why this exists: declared data vs. what the chain read can prove

Off-chain agent directories (A2A cards, the MCP Registry, OASF, NANDA) list **self-declared** agents. That is
exactly where the trust gap lives. A 2026 study of the ERC-8004 ecosystem (arXiv 2606.26028) found that only
**3–15% of registrations have a live endpoint**, and **59–91% of "reviewers" are Sybils**.

stellar-8004 is the only non-EVM ERC-8004 implementation **we are aware of** running on mainnet (66 agents on
Stellar mainnet as of July 2026; `get_registry_stats` returns the current count). No published survey
enumerates non-EVM deployments — the study above restricts itself to Ethereum, BSC and Base, "the three chains
with the highest registration and feedback volume" — so read that as unrefuted, not as proven. This server
adds something a directory listing cannot give you: a **bounded Reputation-contract reachability probe**.
The current path calls `get_clients_paginated` once with a six-slot observation window. The contract exposes
no authoritative client count/cursor, and expired client-index entries create holes, so even an empty or short
page cannot prove that no later live client exists. Calling `get_summary` over that set would manufacture a
false match or mismatch; this release therefore does not call it and verifies no reputation fields. An
attempted, reachable probe returns `unavailable` with reason `client-set-exhaustion-unprovable`;
`verifiedFields` is empty and average, feedback count, and unique clients all remain unverified.
`verified`/`partial`/`mismatch` are reserved for a future authoritative aggregate. The full status set remains
`verified | partial | mismatch | unavailable | skipped`. Self-declared marketing text (name, description,
service labels, feedback tags) remains **untrusted data**, never instructions (see [Security](#security)).

That fail-closed boundary — plus a versioned **declared-evidence heuristic** — is the product. Normalized
Explorer quality is multiplied by fixed evidence strength (`0.4 × capped volume + 0.6 × effective breadth`).
Effective unique clients cannot exceed feedback rows, and repeated rows per declared client are capped. These
are cost-of-manipulation proxies, not chain verification, proof of personhood, or Sybil resistance.

---

## What it exposes

All three MCP primitives, all read-only:

### Tools

| Tier | Tool | What it does |
|---|---|---|
| **0 · SOW** | `find_agent` | Natural-language discovery → ranked candidates |
| | `rank_agent` | Rank an explicit id set or a query, full 3-axis declared-reputation breakdown + bounded chain reachability |
| | `get_agent_profile` | Deep profile: identity, capabilities, declared reputation + contract-probe limits, recent feedback, unverified A2A projection |
| | `list_services` | Self-declared x402/MPP endpoint candidates; liveness, ownership, conformance, and payment stay unverified |
| **1 · complete-core** | `list_agents` | Paginated, filterable listing, ranked |
| | `leaderboard` | Top agents in a bounded scan (client-side 3-axis rank + coverage) |
| | `resolve_agent` | Any handle (id / stellar:…#id / owner G-address) → canonical identifiers |
| | `get_agents_by_owner` | Current owner API page (up to 20 agents) with explicit continuation coverage |
| | `get_agent_feedback` | Recent on-chain reviews (sanitized, labeled) |
| | `verify_reputation` | Fail-closed Reputation-contract reachability probe; no current fields are verified |
| | `get_agent_card` | Derived, unverified A2A-shaped projection + x402 hint; not protocol-conformance proof |
| | `get_registry_stats` | Exact-count queries + capped sampled metrics, with definitions and coverage |
| | `get_registry_health` | Per-registry indexer staleness |

Full per-tool reference (inputs, outputs, defaults): **[docs/tools.md](docs/tools.md)**.

### Resources — `stellar8004://` (pinnable context)

`registry` · `leaderboard` · `health` · `agent/{id}` · `agent/{id}/card` · `agent/{id}/feedback` ·
`agent/{id}/reputation` · `owner/{address}`. Each returns a dual **JSON + rendered-markdown** payload.

### Prompts — slash workflows

`/find-and-vet-agent` (flagship) · `/vet-agent` · `/compare-agents` · `/prepare-x402-call` ·
`/explore-registry`. `prepare-x402-call` lays out the exact x402 flow and **stops before signing** — this
server holds no keys.

---

## Quickstart

**One-command MCP setup (Claude Code):**

```bash
npx -y stellar-agent-search@0.1.0 setup --client claude --scope user --handshake
```

This downloads the package, registers a version-pinned `npx -y stellar-agent-search@0.1.0 mcp` stdio launch through
Claude Code's own CLI, then performs a real MCP initialize + `tools/list` handshake. It is idempotent: rerun
with `--check --handshake` to verify without changing config, or use `--dry-run` to preview the registration.
Cursor and Codex examples, config paths, and scope limitations are in
**[docs/getting-started.md](docs/getting-started.md)**. Manual configs for other clients remain in
**[docs/integration.md](docs/integration.md)**.

Optionally install the **skill** first — the usage guide your agent reads before it calls anything:

```bash
npx skills add berkingurcan/stellar-agent-search --skill mcp
```

**Terminal (human CLI):**

```bash
npx -y stellar-agent-search@0.1.0 find "web scraper" --x402       # discover
npx -y stellar-agent-search@0.1.0 profile 10                       # full profile for agent 10
npx -y stellar-agent-search@0.1.0 rank "scraping agents" --json    # rank + fail-closed contract-probe status, machine-readable
npx -y stellar-agent-search@0.1.0 services --x402                  # declared paid-endpoint candidates
npx -y stellar-agent-search@0.1.0 doctor                           # self-check: env, explorer, RPC, bounded read path
npx -y stellar-agent-search@0.1.0 setup --client cursor --scope project --dry-run  # preview client config
```

New here? Start with **[docs/getting-started.md](docs/getting-started.md)**.

### Remote endpoint status

The intended hosted URL is `https://mcp.stellar8004.com/mcp`. The Worker, transport tests, routing, and
hardening are implemented, but **the route has not been deployed**: `/mcp` currently falls through to the
landing site and returns 404. Deployment remains deliberately blocked until the Cloudflare rate-limit
namespace is replaced from its sentinel value and a live canary proves that the original caller identity is
preserved through the Service Binding. Do not configure a remote MCP client against that URL yet.

The landing page and MCP runtime are separate Workers. The assets-only landing Worker owns the
`mcp.stellar8004.com` custom domain; exact `/mcp` and `/healthz` zone routes will send only those two paths to
the runtime Worker. The runtime reads the existing `stellar8004-web` API through a Cloudflare Service Binding.
It does **not** connect to Supabase, hold a service-role key, or create a second indexer. See
**[docs/architecture.md](docs/architecture.md)** and
**[docs/stellar8004-integration.md](docs/stellar8004-integration.md)**.

---

## Configuration

All configuration is via environment variables (canonical for MCP mode); CLI flags override them
(precedence: flag → env → default).

| Env var | Default | Purpose |
|---|---|---|
| `STELLAR_NETWORK` | `mainnet` | `mainnet` or `testnet` — `testnet` also requires `EXPLORER_BASE_URL`, see below |
| `EXPLORER_BASE_URL` | `https://stellar8004.com` | Explorer HTTP API base. **Indexes mainnet only** |
| `STELLAR_RPC_URL` | `https://mainnet.sorobanrpc.com` | Soroban RPC for the bounded Reputation-contract reachability probe |
| `VERIFY_ONCHAIN` | `true` | Set `false` to skip the probe; reputation remains declared-only either way |
| `RANK_SCORE_MAX` | `100` | Fixed v1 compatibility assertion; any value other than `100` is rejected |

Ranking uses the fixed, versioned `stellar-agent-search-declared-evidence-v1` policy: indexed average normalized
against exactly `100`, multiplied by `0.4 × capped volume + 0.6 × effective breadth`. Both a changed
`RANK_SCORE_MAX` and legacy `RANK_W_*` variables are rejected so a deployment cannot silently redefine
published score semantics.

`STELLAR_PRIVATE_KEY` is **intentionally ignored** if present (and warned about on stderr) — this server is
keyless by construction.

> **`testnet` needs its own explorer, and refuses to start without one.** The default explorer indexes
> **mainnet only**, while `STELLAR_NETWORK` also selects the Soroban contracts and RPC. That pairing would give
> you mainnet registry rows alongside testnet on-chain reads — two chains described as one — so
> `STELLAR_NETWORK=testnet` **fails at startup** unless `EXPLORER_BASE_URL` is set explicitly. No public testnet
> indexer exists today, so in practice testnet is for someone running their own; the dry-run gate for the x402
> demo is `DRY_RUN=1` on mainnet, which spends nothing.

---

## Security

- **Read-only and keyless.** No signer, no write clients, no private keys anywhere under `src/`. The only
  keyed actor in the repo is the standalone [`examples/x402-demo.ts`](examples/README.md), run under explicit
  human control.
- **stdout is JSON-RPC only.** Every log/diagnostic goes to stderr, so the protocol stream is never
  corrupted.
- **Trust boundary.** Server-authored summary text (`content[].text`) interpolates only typed/enum/numeric
  values. All agent-authored free text (names, descriptions, service labels, feedback tags) lives only in
  labeled `selfDeclared` slots of the structured output, sanitized (control/zero-width/bidi stripped) and
  length-bounded — never treated as instructions.

Full threat model + disclosure policy: **[SECURITY.md](SECURITY.md)** and
**[docs/architecture.md](docs/architecture.md)**.

---

## How it works

Local MCP client (or terminal) → **one Node binary** → `ExplorerService` (stellar8004 HTTP API, primary
data) + `ReputationVerifier` (Soroban RPC, bounded reachability probe) → canonical stellar-8004 contracts on
mainnet. Indexed reputation remains explicitly **Explorer-declared**; the contract probe either reports its
limited reachability observation or degrades closed without manufacturing a comparison.

The not-yet-live hosted path adds only an edge adapter: remote client → stateless Cloudflare Worker →
existing `stellar8004-web` service → its canonical Supabase-backed index. The Worker never reads Supabase
directly and never owns indexer credentials. It still uses Soroban RPC for the same bounded reachability probe.
Architecture, ranking formula, cache boundaries, and the upstream discovery contract are documented in
**[docs/architecture.md](docs/architecture.md)**.

Built on the split MCP v2 packages (`@modelcontextprotocol/server` and `@modelcontextprotocol/client`
2.0.0), Zod 4, `@trionlabs/stellar8004`, TypeScript ESM, Node ≥ 22. The local stdio handshake currently
negotiates protocol `2025-11-25`; the remote handler targets the modern stateless `2026-07-28` protocol while
retaining a stateless legacy compatibility lane. That is an implementation target, not a live conformance
claim until the remote canary is recorded.

---

## Contributing

Reviewing this against a grant or SOW? Start at **[docs/evidence.md](docs/evidence.md)** — a
deliverable-to-evidence map with verification steps, written to be checked without a technical background.

Known open work and release blockers are tracked in **[issues/](issues/README.md)**, one file per issue.

Bug reports and PRs welcome. Read **[CONTRIBUTING.md](CONTRIBUTING.md)** first — it covers the project layout and
the four invariants CI enforces (read-only/keyless, stdout-is-JSON-RPC-only, the trust boundary, and
degrade-closed verification). Release history lives in **[CHANGELOG.md](CHANGELOG.md)**.

## License

MIT — see [LICENSE](LICENSE).
