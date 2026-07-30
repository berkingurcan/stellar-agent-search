import type { InstallConfig } from './install-types.js';
import packageMetadata from '../../../package.json';

/**
 * Post-publication onboarding payload. This module is deliberately outside the
 * pre-release module graph. Switch install.ts only after npm ownership,
 * artifact integrity, provenance, and the MCP Registry entry are verified.
 *
 * Every entry mirrors docs/integration.md — the landing must never claim an
 * install path the docs don't back.
 */
export const PACKAGE_PUBLISHED = true;
const PACKAGE_SPEC = `stellar-agent-search@${packageMetadata.version}`;
export const HERO_CMD =
	`npx -y ${PACKAGE_SPEC} find "a paid web scraper with a good reputation"`;

const MCP_SERVERS_JSON = `{
  "mcpServers": {
    "stellar-agent": {
      "command": "npx",
      "args": ["-y", "${PACKAGE_SPEC}", "mcp"],
      "env": { "STELLAR_NETWORK": "mainnet" }
    }
  }
}`;

export const CONFIGS: InstallConfig[] = [
	{
		id: 'claude-code',
		label: 'Claude Code',
		tagline: 'One command registers the server through Claude Code’s own CLI, then performs a live MCP handshake.',
		lang: 'bash',
		code: `npx -y ${PACKAGE_SPEC} setup --client claude --scope user --handshake

# The idempotent setup records this explicit stdio launch:
# npx -y ${PACKAGE_SPEC} mcp

# Optional: install the skill your agent reads before calling anything
npx skills add berkingurcan/stellar-agent-search --skill mcp`,
		note: 'Re-run with --check --handshake to verify without changing config, or use --dry-run to preview the registration.'
	},
	{
		id: 'codex',
		label: 'Codex',
		tagline: 'Same idempotent setup, targeting Codex’s TOML config — or register through Codex itself.',
		lang: 'bash',
		code: `npx -y ${PACKAGE_SPEC} setup --client codex --scope user --handshake

# or let Codex write its own config:
codex mcp add stellar-agent -- npx -y ${PACKAGE_SPEC} mcp`,
		note: 'Codex reads [mcp_servers.stellar-agent] from ~/.codex/config.toml — a JSON mcpServers block does nothing there. Asking setup for project scope prints the exact TOML without modifying anything.'
	},
	{
		id: 'opencode',
		label: 'OpenCode',
		tagline: 'One block in opencode.json — project root or ~/.config/opencode.',
		lang: 'json',
		code: `{
  "mcp": {
    "stellar-agent": {
      "type": "local",
      "command": ["npx", "-y", "${PACKAGE_SPEC}", "mcp"],
      "enabled": true
    }
  }
}`,
		note: 'OpenCode uses an "mcp" root key with a command array, not the mcpServers shape. Restart the TUI after saving; all 13 tools appear read-only.'
	},
	{
		id: 'cursor',
		label: 'Cursor',
		tagline: 'Project-scoped .cursor/mcp.json — conflicts are reported, never overwritten.',
		lang: 'bash',
		code: `npx -y ${PACKAGE_SPEC} setup --client cursor --scope project --handshake

# The atomic config update records this explicit stdio launch:
# npx -y ${PACKAGE_SPEC} mcp`,
		note: 'Existing matching config is left unchanged. Read-only limits server-side actions, but endpoint candidates remain self-declared, so keep client approvals aligned with your own policy.'
	},
	{
		id: 'hermes',
		label: 'Hermes',
		tagline: 'Standard mcpServers JSON — drop the block into Hermes’ MCP config file.',
		lang: 'json',
		code: MCP_SERVERS_JSON,
		note: 'Same shape as Claude Code. The server stays read-only and keyless regardless of client.'
	},
	{
		id: 'openclaw',
		label: 'OpenClaw',
		tagline: 'Same mcpServers JSON in project .mcp.json — resources and slash prompts included.',
		lang: 'json',
		code: MCP_SERVERS_JSON,
		note: 'OpenClaw agents can call all 13 read-only tools, pin resources via @stellar-agent:stellar8004://…, and use slash prompts like /mcp__stellar-agent__find-and-vet-agent.'
	},
	{
		id: 'cli',
		label: 'Terminal',
		tagline: 'No agent required — the same binary is a plain terminal tool.',
		lang: 'bash',
		code: `npx -y ${PACKAGE_SPEC} find "web scraper" --x402   # discover
npx -y ${PACKAGE_SPEC} profile 10                  # full profile for agent 10
npx -y ${PACKAGE_SPEC} rank "scraping agents" --json
npx -y ${PACKAGE_SPEC} services --x402             # self-declared endpoint candidates
npx -y ${PACKAGE_SPEC} doctor                      # self-check`,
		note: '--json makes every command machine-readable.'
	}
];
