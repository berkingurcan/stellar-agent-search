import type { InstallConfig } from './install-types.js';
import packageMetadata from '../../../package.json';

/**
 * Post-publication onboarding payload. This module is deliberately outside the
 * pre-release module graph. Switch install.ts only after npm ownership,
 * artifact integrity, provenance, and the MCP Registry entry are verified.
 */
export const PACKAGE_PUBLISHED = true;
const PACKAGE_SPEC = `stellar-agent-search@${packageMetadata.version}`;
export const HERO_CMD =
	`npx -y ${PACKAGE_SPEC} find "a paid web scraper with a good reputation"`;

export const CONFIGS: InstallConfig[] = [
	{
		id: 'claude-code',
		label: 'Claude Code',
		lang: 'bash',
		code: `npx -y ${PACKAGE_SPEC} setup --client claude --scope user --handshake

# The idempotent setup records this explicit stdio launch:
# npx -y ${PACKAGE_SPEC} mcp

# Optional: install the skill your agent reads before calling anything
npx skills add berkingurcan/stellar-agent-search --skill mcp`,
		note: 'Re-run with --check --handshake to verify without changing config, or use --dry-run to preview the registration.'
	},
	{
		id: 'cursor',
		label: 'Cursor',
		lang: 'bash',
		code: `npx -y ${PACKAGE_SPEC} setup --client cursor --scope project --handshake

# The atomic config update records this explicit stdio launch:
# npx -y ${PACKAGE_SPEC} mcp`,
		note: 'Existing matching config is left unchanged; conflicts are reported, never overwritten. Read-only limits server-side actions, but endpoint candidates remain self-declared, so keep client approvals aligned with your own policy. Manual configs for other clients are in docs/integration.md.'
	},
	{
		id: 'cli',
		label: 'Terminal',
		lang: 'bash',
		code: `npx -y ${PACKAGE_SPEC} find "web scraper" --x402   # discover
npx -y ${PACKAGE_SPEC} profile 10                  # full profile for agent 10
npx -y ${PACKAGE_SPEC} rank "scraping agents" --json
npx -y ${PACKAGE_SPEC} services --x402             # self-declared endpoint candidates
npx -y ${PACKAGE_SPEC} doctor                      # self-check`,
		note: 'The same binary is a plain terminal tool. --json makes every command machine-readable.'
	}
];
