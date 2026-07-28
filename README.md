# stellar-agent-mcp

[![CI](https://github.com/berkingurcan/stellar-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/berkingurcan/stellar-agent-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/stellar-agent-mcp.svg)](https://www.npmjs.com/package/stellar-agent-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-1.29.0-6E56CF.svg)](https://modelcontextprotocol.io)

> **The reference ERC-8004 + x402 trust loop that actually runs on mainnet, with on-chain-verified reputation.**

A **read-only, keyless** MCP server (and human CLI) that lets an AI agent — or you — **discover, rank, and
vet on-chain [stellar-8004](https://stellar8004.com) agents** on Stellar mainnet, then prepare an x402
(USDC pay-per-call) payment. One binary speaks the [Model Context Protocol](https://modelcontextprotocol.io)
over stdio to Claude Code / Cursor / Windsurf / Cline / VS Code, and doubles as a plain-terminal tool.

```bash
npx -y stellar-agent-mcp find "a paid web scraper with a good reputation"
```

---

## Why this exists: declared vs. verified

Off-chain agent directories (A2A cards, the MCP Registry, OASF, NANDA) list **self-declared** agents. That is
exactly where the trust gap lives. A 2026 study of the ERC-8004 ecosystem (arXiv 2606.26028) found that only
**3–15% of registrations have a live endpoint**, and **59–91% of "reviewers" are Sybils**.

stellar-8004 is the **only live non-EVM ERC-8004 implementation** (66 agents on Stellar mainnet). This server
is built around the one thing a directory listing cannot give you: it **re-derives each agent's reputation
directly from the on-chain Reputation contract** (`get_summary` + `get_clients_paginated`) and reports it as a
**declared-vs-verified** diff — `verified | mismatch | unavailable | skipped`. Self-declared marketing text
(name, description, service labels, feedback tags) is treated as **untrusted data**, never as instructions
(see [Security](#security)).

That verification overlay — plus a sybil-resistant ranking that weights **unique clients** (breadth, hard to
fake) above raw feedback volume (cheap to fake) — is the product.

---

## What it exposes

All three MCP primitives, all read-only:

### Tools

| Tier | Tool | What it does |
|---|---|---|
| **0 · SOW** | `find_agent` | Natural-language discovery → ranked candidates |
| | `rank_agent` | Rank an explicit id set or a query, full 3-axis breakdown + on-chain verify |
| | `get_agent_profile` | Deep profile: identity, capabilities, declared-vs-verified reputation, recent feedback, A2A AgentCard |
| | `list_services` | Catalog of invokable x402/MPP service endpoints |
| **1 · complete-core** | `list_agents` | Paginated, filterable listing, ranked |
| | `leaderboard` | Top agents overall (client-side 3-axis rank) |
| | `resolve_agent` | Any handle (id / stellar:…#id / owner G-address) → canonical identifiers |
| | `get_agents_by_owner` | Every agent an owner operates |
| | `get_agent_feedback` | Recent on-chain reviews (sanitized, labeled) |
| | `verify_reputation` | Standalone declared-vs-on-chain reputation check |
| | `get_agent_card` | Portable A2A AgentCard (v0.3) + x402 hint — the interop surface |
| | `get_registry_stats` | Aggregate registry statistics |
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

**Zero-install (MCP client):** point any client at `npx -y stellar-agent-mcp`. See
**[docs/integration.md](docs/integration.md)** for copy-paste configs.

**Claude Code, one line:**

```bash
claude mcp add stellar-agent -- npx -y stellar-agent-mcp
```

> The `--` is required — everything after it is passed to the server untouched. Without it, Claude Code tries
> to parse the server's flags as its own.

**Terminal (human CLI):**

```bash
npx -y stellar-agent-mcp find "web scraper" --x402       # discover
npx -y stellar-agent-mcp profile 10                       # full profile for agent 10
npx -y stellar-agent-mcp rank "scraping agents" --json    # rank + verify, machine-readable
npx -y stellar-agent-mcp services --x402                  # callable paid endpoints
npx -y stellar-agent-mcp doctor                           # self-check: env, explorer, RPC, verify
```

New here? Start with **[docs/getting-started.md](docs/getting-started.md)**.

---

## Configuration

All configuration is via environment variables (canonical for MCP mode); CLI flags override them
(precedence: flag → env → default).

| Env var | Default | Purpose |
|---|---|---|
| `STELLAR_NETWORK` | `mainnet` | `mainnet` or `testnet` |
| `EXPLORER_BASE_URL` | `https://stellar8004.com` | Explorer HTTP API base |
| `STELLAR_RPC_URL` | `https://mainnet.sorobanrpc.com` | Soroban RPC for on-chain verification |
| `VERIFY_ONCHAIN` | `true` | Set `false` to skip Soroban reads (declared-only) |
| `RANK_SCORE_MAX` | `100` | Feedback score scale (values are 0..100 ints) |
| `RANK_W_QUALITY` / `RANK_W_VOLUME` / `RANK_W_BREADTH` | `0.5` / `0.2` / `0.3` | 3-axis weights (re-normalized to sum 1) |

`STELLAR_PRIVATE_KEY` is **intentionally ignored** if present (and warned about on stderr) — this server is
keyless by construction.

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

MCP client (or terminal) → **one binary** → `ExplorerService` (stellar8004 HTTP API, primary data) +
`ReputationVerifier` (Soroban RPC, on-chain verify) → canonical stellar-8004 contracts on mainnet. Data
precedence is always **explorer → on-chain verify → degrade-closed to declared-only**. Architecture,
ranking formula, and the RegistrySource abstraction: **[docs/architecture.md](docs/architecture.md)**.

Built on the stable MCP **1.x** SDK (`@modelcontextprotocol/sdk` 1.29.0, spec 2025-11-25),
`@trionlabs/stellar8004`, TypeScript ESM, Node ≥ 18.

---

## Contributing

Reviewing this against a grant or SOW? Start at **[docs/evidence.md](docs/evidence.md)** — a
deliverable-to-evidence map with verification steps, written to be checked without a technical background.

Bug reports and PRs welcome. Read **[CONTRIBUTING.md](CONTRIBUTING.md)** first — it covers the project layout and
the four invariants CI enforces (read-only/keyless, stdout-is-JSON-RPC-only, the trust boundary, and
degrade-closed verification). Release history lives in **[CHANGELOG.md](CHANGELOG.md)**.

## License

MIT — see [LICENSE](LICENSE).
