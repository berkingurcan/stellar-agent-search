# Getting started

> **Pre-release:** the npm name is not yet owned by this project. Until the
> [official package page](https://www.npmjs.com/package/stellar-agent-mcp) shows version 0.1.0, do not run an
> `npx stellar-agent-mcp` command. The setup flow below pins `@0.1.0` into persistent client configuration
> after the official package exists.

`stellar-agent-mcp` is a single Node binary with three entry points:

- **MCP stdio server** — how an MCP client (Claude Code, Cursor, Windsurf, Cline, VS Code) launches it.
- **Client bootstrap** — the idempotent `setup` command registers that server with Claude Code, Cursor, or Codex.
- **Human CLI** — subcommands (`find`, `rank`, `profile`, `services`, `doctor`) for a plain terminal.

It is **read-only and keyless**: it reads the stellar-8004 explorer API and simulates bounded Soroban view
calls that compare average and active feedback count. It never signs, never writes, and holds no private keys.

## Requirements

- **Node.js ≥ 20**.
- Outbound HTTPS to `https://stellar8004.com` (explorer) and `https://mainnet.sorobanrpc.com` (Soroban RPC).
- No account, no API key, no wallet.

## Run it as a CLI (no install)

```bash
# Natural-language discovery → a ranked candidate table
npx -y stellar-agent-mcp@0.1.0 find "a paid web scraper with a good reputation"

# Only agents that accept x402 (USDC pay-per-call)
npx -y stellar-agent-mcp@0.1.0 find "scraper" --x402

# Full profile for a specific agent (declared vs bounded chain evidence, capabilities, services)
npx -y stellar-agent-mcp@0.1.0 profile 10

# Rank a query's candidates or an explicit id set, with bounded chain comparison on
npx -y stellar-agent-mcp@0.1.0 rank "scraping agents"
npx -y stellar-agent-mcp@0.1.0 rank 10 12 15

# Catalog of self-declared service endpoint candidates
npx -y stellar-agent-mcp@0.1.0 services --x402

# Machine-readable output for any command
npx -y stellar-agent-mcp@0.1.0 find "scraper" --json
```

### Verify your environment

```bash
npx -y stellar-agent-mcp@0.1.0 doctor
```

`doctor` prints a pass/fail checklist and exits non-zero on failure — the first thing to run when something
does not work:

```
✔ node      v20.11.0 (>=20 required)
✔ network   mainnet
✔ read-only keyless (no signer, no writes)
✔ explorer  https://stellar8004.com  status=healthy  identity ledger 63,699,173 (fresh)
✔ soroban   https://mainnet.sorobanrpc.com  healthy
✔ verify    on-chain reputation read OK (sampled agent #10: avg 96, 8 comparable feedback; active unique clients are not derived by this read)
✔ tools     find_agent, rank_agent, get_agent_profile, list_services (+ list_agents, leaderboard)
ℹ server    stellar-agent-mcp  ·  @modelcontextprotocol/server 2.0.0  ·  spec 2025-11-25
```

Add `--json` for CI.

## Use it from an MCP client

Use the bootstrap instead of editing client config by hand:

```bash
# Claude Code, all projects (uses the Claude CLI)
npx -y stellar-agent-mcp@0.1.0 setup --client claude --scope user --handshake

# Cursor, current project (atomically updates .cursor/mcp.json)
npx -y stellar-agent-mcp@0.1.0 setup --client cursor --scope project --handshake

# Codex, user config (uses the Codex CLI)
npx -y stellar-agent-mcp@0.1.0 setup --client codex --scope user --handshake
```

All three register the same version-pinned stdio launch: `npx -y stellar-agent-mcp@0.1.0 mcp`. Existing matching entries
are left unchanged; conflicting entries are reported and never overwritten. `--handshake` starts the current
package, initializes MCP, and prints the complete tool list.

Useful non-mutating modes:

```bash
# Is this client already configured, and can this package list its tools?
npx -y stellar-agent-mcp@0.1.0 setup --client cursor --scope project --check --handshake

# Show the exact command/config that would be added
npx -y stellar-agent-mcp@0.1.0 setup --client cursor --scope project --dry-run --json
```

`--check` and `--dry-run` are mutually exclusive; either can be combined with `--handshake`. Claude and Cursor
support both `user` and `project` scopes. Codex setup is automated only at `user` scope because the Codex CLI
does not expose a project-scoped MCP add operation. Asking for `--client codex --scope project` makes no change,
exits non-zero, and prints the exact `[mcp_servers.stellar-agent]` TOML to merge into `.codex/config.toml`.

Optionally install the **skill** as well. It is the usage guide your agent reads before it calls anything —
which tools exist, when to request bounded chain evidence, and how to read a snapshot-unversioned mismatch:

```bash
npx skills add berkingurcan/stellar-agent-mcp --skill mcp
```

The skill documents the registration step for eight clients, so it is also the quickest reference for clients
outside the three supported by `setup`. Installing the skill copies usage guidance; it does not register the
runtime by itself.

Then, in the client, tools appear as `mcp__stellar-agent__find_agent` (etc.), resources are
`@`-mentionable (`@stellar-agent:stellar8004://agent/10`), and prompts are `/mcp__stellar-agent__…` slash
commands. Copy-paste configs for every client are in **[integration.md](integration.md)**.

### Remote HTTP status

A stateless Cloudflare adapter is implemented for the intended URL
`https://mcp.stellar8004.com/mcp`, but it is **not deployed or ready for client configuration**. That path
currently returns the landing site's 404. Use stdio for now.

The remote deploy is intentionally gated on two items: replacing the sentinel Cloudflare rate-limit
namespace and proving with a live canary that the original caller identity survives the Service Binding to
the existing `stellar8004-web` API. The Worker has no direct Supabase connection, no service-role key, and no
shadow indexer. See [architecture.md](architecture.md#remote-cloudflare-adapter-implemented-not-live) for the
request, cache, trust, and rollout boundaries.

### First things to try in-client

1. Run the flagship prompt **`/find-and-vet-agent`** with a task like "scrape a website and return JSON".
2. Ask the model to **rank** the candidates and compare the top one's average/count with the bounded
   Reputation-contract read. A healthy result is `partial`, with `snapshotComparable: false`; it does not
   verify `uniqueClients`.
3. Pin **`@stellar-agent:stellar8004://leaderboard`** to keep the current top agents in context.

## Optional install (faster cold start)

`npx -y` downloads the package on first use, which can exceed a client's connect timeout on a slow network
(the server then shows `failed` and works on retry). To avoid that, install globally and point the client at
the global bin:

```bash
npm i -g stellar-agent-mcp@0.1.0
```

```json
{ "mcpServers": { "stellar-agent": { "command": "stellar-agent-mcp", "args": [] } } }
```

This global-bin config is an advanced manual exception: `setup` intentionally records the portable
`npx -y stellar-agent-mcp@0.1.0 mcp` launch so the same registration works without a prior global install. You can
also raise `MCP_TIMEOUT` for the client.

## Configuration knobs

| Env var | Default | Purpose |
|---|---|---|
| `STELLAR_NETWORK` | `mainnet` | `mainnet` or `testnet` (`testnet` also requires `EXPLORER_BASE_URL`) |
| `EXPLORER_BASE_URL` | `https://stellar8004.com` | Explorer HTTP API base — **indexes mainnet only** |
| `STELLAR_RPC_URL` | `https://mainnet.sorobanrpc.com` | Soroban RPC for verification |
| `VERIFY_ONCHAIN` | `true` | `false` = skip Soroban reads (faster, declared-only) |
| `RANK_SCORE_MAX` | `100` | Feedback score scale |
| `RANK_W_QUALITY` / `RANK_W_VOLUME` / `RANK_W_BREADTH` | `0.5` / `0.2` / `0.3` | Ranking axis weights |

CLI flags override env (`--network`, `--explorer-url`, `--rpc-url`, `--no-verify`, `--limit`, `--min-score`,
`--x402`, `--mpp`, `--json`). Setup adds `--client`, `--scope`, `--check`, `--dry-run`, and `--handshake`.
Precedence is **flag → env → default**.

> **Keyless by construction.** If `STELLAR_PRIVATE_KEY` is set in the environment, the server ignores it and
> warns on stderr. `setup` also generates an exact allowlisted MCP `env` map and treats any existing entry with
> extra variables as a conflict, so it does not normalize or silently retain credentials. Signing lives only
> in the separate `examples/x402-demo.ts`.

## Next steps

- **[tools.md](tools.md)** — every tool's inputs, outputs, and defaults.
- **[integration.md](integration.md)** — per-client MCP configuration.
- **[architecture.md](architecture.md)** — data flow, the 3-axis ranking formula, and the trust model.
- **[../SECURITY.md](../SECURITY.md)** — threat model and disclosure policy.
