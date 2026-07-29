import type { InstallConfig } from './install-types.js';

/**
 * Post-publication onboarding payload. This module is deliberately outside the
 * pre-release module graph. Switch install.ts only after npm ownership,
 * artifact integrity, provenance, and the MCP Registry entry are verified.
 */
export const PACKAGE_PUBLISHED = true;
export const HERO_CMD =
	'npx -y stellar-agent-mcp@0.1.0 find "a paid web scraper with a good reputation"';

export const CONFIGS: InstallConfig[] = [
	{
		id: 'claude-code',
		label: 'Claude Code',
		lang: 'bash',
		code: `npx -y stellar-agent-mcp@0.1.0 setup --client claude --scope user --handshake

# The idempotent setup records this explicit stdio launch:
# npx -y stellar-agent-mcp@0.1.0 mcp

# Optional: install the skill your agent reads before calling anything
npx skills add berkingurcan/stellar-agent-mcp --skill mcp`,
		note: 'Re-run with --check --handshake to verify without changing config, or use --dry-run to preview the registration.'
	},
	{
		id: 'cursor',
		label: 'Cursor',
		lang: 'bash',
		code: `npx -y stellar-agent-mcp@0.1.0 setup --client cursor --scope project --handshake

# The atomic config update records this explicit stdio launch:
# npx -y stellar-agent-mcp@0.1.0 mcp`,
		note: 'Existing matching config is left unchanged; conflicts are reported, never overwritten. Read-only limits server-side actions, but endpoint candidates remain self-declared, so keep client approvals aligned with your own policy. Manual configs for other clients are in docs/integration.md.'
	},
	{
		id: 'cli',
		label: 'Terminal',
		lang: 'bash',
		code: `npx -y stellar-agent-mcp@0.1.0 find "web scraper" --x402   # discover
npx -y stellar-agent-mcp@0.1.0 profile 10                  # full profile for agent 10
npx -y stellar-agent-mcp@0.1.0 rank "scraping agents" --json
npx -y stellar-agent-mcp@0.1.0 services --x402             # self-declared endpoint candidates
npx -y stellar-agent-mcp@0.1.0 doctor                      # self-check`,
		note: 'The same binary is a plain terminal tool. --json makes every command machine-readable.'
	}
];
