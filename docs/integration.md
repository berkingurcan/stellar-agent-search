# Integration — MCP client configuration

`stellar-agent-mcp` is a **stdio** MCP server. Every client launches it the same way — `npx -y
stellar-agent-mcp` with no subcommand — because the binary starts the MCP server automatically when its
stdin is not a TTY. Below are copy-paste configs for each supported client.

All clients share the same `mcpServers` JSON shape **except VS Code**, which uses a `servers` key.

The canonical stdio entry (works for Claude Code, Cursor, Windsurf, Claude Desktop):

```json
{
  "mcpServers": {
    "stellar-agent": {
      "command": "npx",
      "args": ["-y", "stellar-agent-mcp"],
      "env": { "STELLAR_NETWORK": "mainnet" }
    }
  }
}
```

> A stdio entry has **no `type` field** (or `"type": "stdio"`). The four env vars `EXPLORER_BASE_URL`,
> `STELLAR_RPC_URL`, `VERIFY_ONCHAIN`, `RANK_*` are all optional overrides — see [tools.md](tools.md) and the
> README config table.

---

## Claude Code

**One-liner (recommended):**

```bash
# local scope (default; just you) — stored in ~/.claude.json
claude mcp add stellar-agent -- npx -y stellar-agent-mcp

# user scope (all your projects)
claude mcp add --scope user stellar-agent -- npx -y stellar-agent-mcp

# project scope (committed to .mcp.json, shared with the team)
claude mcp add --scope project stellar-agent -- npx -y stellar-agent-mcp

# with a network override
claude mcp add --env STELLAR_NETWORK=mainnet stellar-agent -- npx -y stellar-agent-mcp
```

> **The `--` is mandatory.** Everything after `--` is the server command, passed untouched. Without it,
> Claude Code parses the server's own flags (e.g. `--network`) as its own. If you use `--env`, put the
> server name **after** it, or the CLI eats the name as a `KEY=value` pair.

**Project `.mcp.json`** (committed, shared with the team):

```json
{
  "mcpServers": {
    "stellar-agent": {
      "command": "npx",
      "args": ["-y", "stellar-agent-mcp"],
      "env": { "STELLAR_NETWORK": "mainnet" }
    }
  }
}
```

**How it appears:** the `/mcp` panel lists `stellar-agent` with a tool count and connection status
(project-scoped servers show `⏸ Pending approval` until you approve). Tools are referenced as
`mcp__stellar-agent__find_agent`, resources as `@stellar-agent:stellar8004://agent/10`, prompts as
`/mcp__stellar-agent__find-and-vet-agent`.

**Manage:** `claude mcp list` · `claude mcp get stellar-agent` · `claude mcp remove stellar-agent`.

---

## Cursor

**File:** project `.cursor/mcp.json` (repo root) or global `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "stellar-agent": {
      "command": "npx",
      "args": ["-y", "stellar-agent-mcp"],
      "env": { "STELLAR_NETWORK": "mainnet" }
    }
  }
}
```

Cursor lists the server (with a toggle and its tools) under **Settings → MCP** and shows an approval prompt
with arguments before executing a tool.

---

## Windsurf

**File:** `~/.codeium/windsurf/mcp_config.json` (Windows:
`%USERPROFILE%\.codeium\windsurf\mcp_config.json`). Windsurf supports stdio and Streamable HTTP (not legacy
SSE) and uses `${env:VAR}` interpolation.

```json
{
  "mcpServers": {
    "stellar-agent": {
      "command": "npx",
      "args": ["-y", "stellar-agent-mcp"],
      "env": { "STELLAR_NETWORK": "${env:STELLAR_NETWORK}" }
    }
  }
}
```

Manage it from the Cascade panel's **Manage plugins / raw config** button.

---

## Cline

**File:** `cline_mcp_settings.json` (open via **MCP Servers → Configure**). Cline adds `disabled` and
`autoApprove`.

```json
{
  "mcpServers": {
    "stellar-agent": {
      "command": "npx",
      "args": ["-y", "stellar-agent-mcp"],
      "env": { "STELLAR_NETWORK": "mainnet" },
      "disabled": false,
      "autoApprove": ["find_agent", "get_agent_profile", "list_services", "rank_agent"]
    }
  }
}
```

> Because every tool is **read-only**, listing them in `autoApprove` is safe and gives a friction-free
> experience. You can add the Tier-1 tools (`list_agents`, `leaderboard`, `resolve_agent`,
> `get_agents_by_owner`, `get_agent_feedback`, `verify_reputation`, `get_registry_stats`,
> `get_registry_health`) to `autoApprove` as well.

---

## VS Code (GitHub Copilot)

**File:** `.vscode/mcp.json` — note the **`servers`** key (not `mcpServers`).

```json
{
  "servers": {
    "stellar-agent": {
      "command": "npx",
      "args": ["-y", "stellar-agent-mcp"],
      "env": { "STELLAR_NETWORK": "mainnet" }
    }
  }
}
```

---

## Claude Desktop

**File:** `claude_desktop_config.json`. Same shape as Cursor/Claude Code (`"type": "stdio"` optional):

```json
{
  "mcpServers": {
    "stellar-agent": {
      "command": "npx",
      "args": ["-y", "stellar-agent-mcp"],
      "env": { "STELLAR_NETWORK": "mainnet" }
    }
  }
}
```

---

## Config matrix

| Client | Config file | Root key | Client-specific fields | Register via |
|---|---|---|---|---|
| Claude Code | `.mcp.json` / `~/.claude.json` | `mcpServers` | `type`, `timeout`, `alwaysLoad` | `claude mcp add stellar-agent -- npx -y stellar-agent-mcp` |
| Cursor | `.cursor/mcp.json` / `~/.cursor/mcp.json` | `mcpServers` | — | Settings → MCP |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | `${env:VAR}` interpolation | Cascade → Manage plugins |
| Cline | `cline_mcp_settings.json` | `mcpServers` | `disabled`, `autoApprove` | MCP Servers → Configure |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` | `type` | edit file |
| VS Code | `.vscode/mcp.json` | **`servers`** | `${input:}` | edit file |

---

## Explicit start / alternate forms

- **Force the server explicitly** (unambiguous config): use the `mcp` (or `serve`) subcommand.
  ```json
  { "mcpServers": { "stellar-agent": { "command": "npx", "args": ["-y", "stellar-agent-mcp", "mcp"] } } }
  ```
- **Global install** (avoids `npx` cold-start latency):
  ```bash
  npm i -g stellar-agent-mcp
  ```
  ```json
  { "mcpServers": { "stellar-agent": { "command": "stellar-agent-mcp", "args": [] } } }
  ```

## Troubleshooting

- **Server shows `failed` on first launch, works on retry** — cold `npx -y` download exceeded the client's
  connect budget. Install globally (above) or raise `MCP_TIMEOUT`.
- **No tools appear / wrong network** — run `npx -y stellar-agent-mcp doctor` in a terminal to check
  explorer reachability, RPC health, and the active network.
- **Project-scoped server stuck pending (Claude Code)** — approve it in the `/mcp` panel (a security gate
  for committed `.mcp.json`).
- **stdout corruption errors** — this server sends only JSON-RPC to stdout; if you wrap it, make sure your
  wrapper does not print to stdout.
