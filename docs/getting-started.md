# Getting started

`stellar-agent-mcp` is a single Node binary that runs in two modes from one command:

- **MCP stdio server** — how an MCP client (Claude Code, Cursor, Windsurf, Cline, VS Code) launches it.
- **Human CLI** — subcommands (`find`, `rank`, `profile`, `services`, `doctor`) for a plain terminal.

It is **read-only and keyless**: it reads the stellar-8004 explorer API and simulates Soroban view calls to
verify reputation on-chain. It never signs, never writes, and holds no private keys.

## Requirements

- **Node.js ≥ 18** (uses the global `fetch`).
- Outbound HTTPS to `https://stellar8004.com` (explorer) and `https://mainnet.sorobanrpc.com` (Soroban RPC).
- No account, no API key, no wallet.

## Run it as a CLI (no install)

```bash
# Natural-language discovery → a ranked candidate table
npx -y stellar-agent-mcp find "a paid web scraper with a good reputation"

# Only agents that accept x402 (USDC pay-per-call)
npx -y stellar-agent-mcp find "scraper" --x402

# Full profile for a specific agent (declared-vs-verified reputation, capabilities, services)
npx -y stellar-agent-mcp profile 10

# Rank a query's candidates or an explicit id set, with on-chain verification on
npx -y stellar-agent-mcp rank "scraping agents"
npx -y stellar-agent-mcp rank 10 12 15

# Catalog of callable service endpoints
npx -y stellar-agent-mcp services --x402

# Machine-readable output for any command
npx -y stellar-agent-mcp find "scraper" --json
```

### Verify your environment

```bash
npx -y stellar-agent-mcp doctor
```

`doctor` prints a pass/fail checklist and exits non-zero on failure — the first thing to run when something
does not work:

```
✔ node      v20.11.0 (>=18 required)
✔ network   mainnet
✔ read-only keyless (no signer, no writes)
✔ explorer  https://stellar8004.com  status=healthy  identity ledger 63,699,173 (fresh)
✔ soroban   https://mainnet.sorobanrpc.com  healthy
✔ verify    on-chain reputation read OK (sampled agent #10: avg 96, 8 feedback, 4 clients)
✔ tools     find_agent, rank_agent, get_agent_profile, list_services (+ list_agents, leaderboard)
ℹ server    stellar-agent-mcp  ·  @modelcontextprotocol/sdk 1.30.0  ·  spec 2025-11-25
```

Add `--json` for CI.

## Use it from an MCP client

Point any MCP client at `npx -y stellar-agent-mcp`. The fastest path for Claude Code:

```bash
claude mcp add stellar-agent -- npx -y stellar-agent-mcp
```

Optionally install the **skill** as well. It is the usage guide your agent reads before it calls anything —
which tools exist, when to verify on-chain, how to read a declared-vs-verified mismatch:

```bash
npx skills add berkingurcan/stellar-agent-mcp --skill mcp
```

The skill documents the registration step for eight clients, so it is also the quickest reference if you are
not on Claude Code.

Then, in the client, tools appear as `mcp__stellar-agent__find_agent` (etc.), resources are
`@`-mentionable (`@stellar-agent:stellar8004://agent/10`), and prompts are `/mcp__stellar-agent__…` slash
commands. Copy-paste configs for every client are in **[integration.md](integration.md)**.

### First things to try in-client

1. Run the flagship prompt **`/find-and-vet-agent`** with a task like "scrape a website and return JSON".
2. Ask the model to **rank** the candidates and **verify** the top one's reputation on-chain.
3. Pin **`@stellar-agent:stellar8004://leaderboard`** to keep the current top agents in context.

## Optional install (faster cold start)

`npx -y` downloads the package on first use, which can exceed a client's connect timeout on a slow network
(the server then shows `failed` and works on retry). To avoid that, install globally and point the client at
the global bin:

```bash
npm i -g stellar-agent-mcp
```

```json
{ "mcpServers": { "stellar-agent": { "command": "stellar-agent-mcp", "args": [] } } }
```

You can also raise `MCP_TIMEOUT` for the client.

## Configuration knobs

| Env var | Default | Purpose |
|---|---|---|
| `STELLAR_NETWORK` | `mainnet` | `mainnet` or `testnet` |
| `EXPLORER_BASE_URL` | `https://stellar8004.com` | Explorer HTTP API base |
| `STELLAR_RPC_URL` | `https://mainnet.sorobanrpc.com` | Soroban RPC for verification |
| `VERIFY_ONCHAIN` | `true` | `false` = skip Soroban reads (faster, declared-only) |
| `RANK_SCORE_MAX` | `100` | Feedback score scale |
| `RANK_W_QUALITY` / `RANK_W_VOLUME` / `RANK_W_BREADTH` | `0.5` / `0.2` / `0.3` | Ranking axis weights |

CLI flags override env (`--network`, `--explorer-url`, `--rpc-url`, `--no-verify`, `--limit`, `--min-score`,
`--x402`, `--mpp`, `--json`). Precedence is **flag → env → default**.

> **Keyless by construction.** If `STELLAR_PRIVATE_KEY` is set in the environment, the server ignores it and
> warns on stderr. Signing lives only in the separate `examples/x402-demo.ts`.

## Next steps

- **[tools.md](tools.md)** — every tool's inputs, outputs, and defaults.
- **[integration.md](integration.md)** — per-client MCP configuration.
- **[architecture.md](architecture.md)** — data flow, the 3-axis ranking formula, and the trust model.
- **[../SECURITY.md](../SECURITY.md)** — threat model and disclosure policy.
