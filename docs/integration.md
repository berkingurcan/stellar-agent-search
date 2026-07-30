# Integration — MCP client configuration

> **Pre-release:** the npm name is not yet owned by this project. Do not execute these `npx` examples until
> the [official package page](https://www.npmjs.com/package/stellar-agent-market) shows version 0.1.0. Persistent
> client entries should pin `stellar-agent-market@0.1.0`; `setup` does this automatically.

The supported, usable transport today is the **local stdio** MCP server. Every client launches the same
explicit version-pinned command — `npx -y stellar-agent-market@0.1.0 mcp`. The binary also auto-detects non-TTY launches, but the
explicit subcommand removes ambiguity across clients. Below are copy-paste configs for each supported client.

The local runtime uses `@modelcontextprotocol/server` 2.0.0 and currently negotiates protocol
`2025-11-25`. A separate Cloudflare Worker implements modern stateless MCP `2026-07-28` discovery
(`server/discover` plus a per-request `_meta` envelope) and a legacy stateless compatibility lane, but it is
**not live**; this distinction is why the remote URL is not included in the copy-paste client configs below.

All clients share the same `mcpServers` JSON shape **except VS Code** (`servers` key) and **Codex CLI**
(TOML `[mcp_servers.*]`).

The canonical stdio entry (works for Claude Code, Cursor, Windsurf, Claude Desktop, Gemini CLI):

```json
{
  "mcpServers": {
    "stellar-agent": {
      "command": "npx",
      "args": ["-y", "stellar-agent-market@0.1.0", "mcp"],
      "env": { "STELLAR_NETWORK": "mainnet" }
    }
  }
}
```

> A stdio entry has **no `type` field** (or `"type": "stdio"`). The four env vars `EXPLORER_BASE_URL`,
> `STELLAR_RPC_URL`, `VERIFY_ONCHAIN`, `RANK_*` are all optional overrides — see [tools.md](tools.md) and the
> README config table.

## Remote Streamable HTTP (not live)

The intended endpoint is:

```text
https://mcp.stellar8004.com/mcp
```

Do **not** configure it yet. `/mcp` currently falls through to the assets-only landing Worker and returns
404. Although the runtime, tests, exact zone routes, and Service Binding adapter are implemented, production
deployment is blocked until its sentinel rate-limit namespace is replaced and a canary proves original-caller
identity through the binding.

When deployed, the runtime will be public, read-only, keyless, unauthenticated, and stateless: a fresh MCP
server per request, no sessions. Browser origins are allowlisted, but originless MCP clients are allowed;
**CORS is not authentication**. The Worker reaches the existing `stellar8004-web` API only through a Service
Binding and does not receive Supabase credentials or maintain a shadow index. Full security and caching limits
are in [architecture.md](architecture.md#remote-cloudflare-adapter-implemented-not-live) and
[../SECURITY.md](../SECURITY.md#hosted-worker-boundary-implemented-not-deployed).

---

## Claude Code

**Safe bootstrap (recommended):**

```bash
npx -y stellar-agent-market@0.1.0 setup --client claude --scope user --handshake
```

This is idempotent, checks for conflicts, registers through Claude's own CLI, and performs a real MCP
initialize + `tools/list` handshake. Use `--scope project` for a committable `.mcp.json`, `--check` to inspect
without changing anything, or `--dry-run --json` to preview the exact registration.

**Manual fallback:**

```bash
# local scope (default; just you) — stored in ~/.claude.json
claude mcp add stellar-agent -- npx -y stellar-agent-market@0.1.0 mcp

# user scope (all your projects)
claude mcp add --scope user stellar-agent -- npx -y stellar-agent-market@0.1.0 mcp

# project scope (committed to .mcp.json, shared with the team)
claude mcp add --scope project stellar-agent -- npx -y stellar-agent-market@0.1.0 mcp

# with a network override
claude mcp add --env STELLAR_NETWORK=mainnet stellar-agent -- npx -y stellar-agent-market@0.1.0 mcp
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
      "args": ["-y", "stellar-agent-market@0.1.0", "mcp"],
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

**Safe bootstrap (recommended):**

```bash
npx -y stellar-agent-market@0.1.0 setup --client cursor --scope project --handshake
```

The command parses strict JSON, refuses symlinks/JSONC/conflicting registrations, and writes through a
same-directory atomic rename. Setup processes share an advisory lock and the file is checked again just before
rename. An unrelated editor does not honor that lock, so a portable filesystem cannot eliminate the final
read-to-rename race; avoid editing this file during setup. Existing entries match only when their explicit
`env` map is exact—an extra private key, token, or even a benign extra variable is treated as a conflict and
is never silently retained.

**File:** project `.cursor/mcp.json` (repo root) or global `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "stellar-agent": {
      "command": "npx",
      "args": ["-y", "stellar-agent-market@0.1.0", "mcp"],
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
      "args": ["-y", "stellar-agent-market@0.1.0", "mcp"],
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
      "args": ["-y", "stellar-agent-market@0.1.0", "mcp"],
      "env": { "STELLAR_NETWORK": "mainnet" },
      "disabled": false,
      "autoApprove": ["find_agent", "get_agent_profile", "list_services", "rank_agent"]
    }
  }
}
```

> These tools cannot sign or write, but their structured results include untrusted registry metadata. Use
> `autoApprove` only if your client/model policy already treats tool output as untrusted data; read-only does
> not eliminate prompt-injection risk. The Tier-1 tools can be added under the same policy.

---

## VS Code (GitHub Copilot)

**File:** `.vscode/mcp.json` — note the **`servers`** key (not `mcpServers`).

```json
{
  "servers": {
    "stellar-agent": {
      "command": "npx",
      "args": ["-y", "stellar-agent-market@0.1.0", "mcp"],
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
      "args": ["-y", "stellar-agent-market@0.1.0", "mcp"],
      "env": { "STELLAR_NETWORK": "mainnet" }
    }
  }
}
```

---

## Codex CLI

Codex uses **TOML**, not JSON, and the table is `[mcp_servers.<name>]` (snake_case `mcp_servers`, not
`mcpServers`).

For user scope, prefer the safe bootstrap:

```bash
npx -y stellar-agent-market@0.1.0 setup --client codex --scope user --handshake
```

Project scope is intentionally manual because `codex mcp add` has no project-scope operation; asking setup
for project scope prints the exact TOML without modifying anything.

**File:** `~/.codex/config.toml`:

```toml
[mcp_servers.stellar-agent]
command = "npx"
args = ["-y", "stellar-agent-market@0.1.0", "mcp"]
env = { STELLAR_NETWORK = "mainnet" }
```

Or add it from the CLI:

```bash
codex mcp add stellar-agent -- npx -y stellar-agent-market@0.1.0 mcp
```

> A JSON `mcpServers` block does nothing in Codex — the table name must be `mcp_servers`.

---

## Gemini CLI

**File:** `~/.gemini/settings.json` (global) or project `.gemini/settings.json`. Same `mcpServers` shape as
Claude Code, plus an optional `trust` field that skips the per-call approval prompt:

```json
{
  "mcpServers": {
    "stellar-agent": {
      "command": "npx",
      "args": ["-y", "stellar-agent-market@0.1.0", "mcp"],
      "env": { "STELLAR_NETWORK": "mainnet" },
      "trust": true
    }
  }
}
```

> `trust: true` removes per-call approval. The tools are read-only and keyless, but registry metadata remains
> untrusted; enable it only if your client/model policy contains indirect prompt injection.

---

## Config matrix

| Client | Config file | Root key | Client-specific fields | Register via |
|---|---|---|---|---|
| Claude Code | `.mcp.json` / `~/.claude.json` | `mcpServers` | `type`, `timeout`, `alwaysLoad` | `stellar-agent-market setup --client claude` |
| Cursor | `.cursor/mcp.json` / `~/.cursor/mcp.json` | `mcpServers` | — | `stellar-agent-market setup --client cursor` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | `${env:VAR}` interpolation | Cascade → Manage plugins |
| Cline | `cline_mcp_settings.json` | `mcpServers` | `disabled`, `autoApprove` | MCP Servers → Configure |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` | `type` | edit file |
| VS Code | `.vscode/mcp.json` | **`servers`** | `${input:}` | edit file |
| Codex CLI | `~/.codex/config.toml` | **`mcp_servers`** (TOML) | — | `stellar-agent-market setup --client codex` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` | `trust` | edit file |

---

## Explicit start / alternate forms

- **Force the server explicitly** (unambiguous config): use the `mcp` (or `serve`) subcommand.
  ```json
  { "mcpServers": { "stellar-agent": { "command": "npx", "args": ["-y", "stellar-agent-market@0.1.0", "mcp"] } } }
  ```
- **Global install** (avoids `npx` cold-start latency):
  ```bash
  npm i -g stellar-agent-market@0.1.0
  ```
  ```json
  { "mcpServers": { "stellar-agent": { "command": "stellar-agent-market", "args": [] } } }
  ```

## Troubleshooting

- **Server shows `failed` on first launch, works on retry** — cold `npx -y` download exceeded the client's
  connect budget. Install globally (above) or raise `MCP_TIMEOUT`.
- **No tools appear / wrong network** — run `npx -y stellar-agent-market@0.1.0 doctor` in a terminal to check
  explorer reachability, RPC health, and the active network.
- **Project-scoped server stuck pending (Claude Code)** — approve it in the `/mcp` panel (a security gate
  for committed `.mcp.json`).
- **stdout corruption errors** — this server sends only JSON-RPC to stdout; if you wrap it, make sure your
  wrapper does not print to stdout.
