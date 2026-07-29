/**
 * The MCP surface, mirrored from README.md and docs/tools.md.
 * Keep in sync when tools are added or renamed — docs/tools.md is canonical.
 */

export type Tool = { name: string; what: string };

/** Tier 0 — the four tools the SOW is written against. */
export const TIER0: Tool[] = [
	{ name: 'find_agent', what: 'Natural-language discovery → ranked candidates' },
	{
		name: 'rank_agent',
		what: 'Rank an explicit id set or a query, full 3-axis breakdown + on-chain verify'
	},
	{
		name: 'get_agent_profile',
		what: 'Deep profile: identity, capabilities, declared-vs-verified reputation, recent feedback, unverified derived A2A-shaped projection'
	},
	{ name: 'list_services', what: 'Catalog of self-declared x402/MPP endpoint candidates' }
];

/** Tier 1 — the rest of the read surface. */
export const TIER1: Tool[] = [
	{ name: 'list_agents', what: 'Paginated, filterable listing, ranked' },
	{ name: 'leaderboard', what: 'Top agents in a bounded scan (client-side rank + coverage)' },
	{
		name: 'resolve_agent',
		what: 'Any handle (id / stellar:…#id / owner G-address) → canonical identifiers'
	},
	{ name: 'get_agents_by_owner', what: 'Current owner page, with explicit continuation coverage' },
	{ name: 'get_agent_feedback', what: 'Recent on-chain reviews (sanitized, labeled)' },
	{ name: 'verify_reputation', what: 'Standalone declared-vs-on-chain reputation check' },
	{
		name: 'get_agent_card',
		what: 'Unverified derived A2A-shaped projection + x402 hint; not protocol-conformance proof'
	},
	{ name: 'get_registry_stats', what: 'Aggregate registry statistics' },
	{ name: 'get_registry_health', what: 'Per-registry indexer staleness' }
];

export const TOOL_COUNT = TIER0.length + TIER1.length;

/**
 * Deliberately false until `stellar-agent-mcp@0.1.0` is owned on npm. A public
 * page must not expose a copyable `npx -y` command for an unclaimed name.
 */
export const PACKAGE_PUBLISHED = false;

/**
 * Small counts read as words in prose ("Four invariants"), not digits. Derived
 * from the arrays rather than typed out, so adding an invariant cannot leave a
 * stale number in a heading. Falls back to the digit above twelve.
 */
const WORDS = [
	'Zero',
	'One',
	'Two',
	'Three',
	'Four',
	'Five',
	'Six',
	'Seven',
	'Eight',
	'Nine',
	'Ten',
	'Eleven',
	'Twelve'
];
export const spellOut = (n: number): string => WORDS[n] ?? String(n);

/** Resources — `stellar8004://` URIs, each returning JSON + rendered markdown. */
export const RESOURCES = [
	'registry',
	'leaderboard',
	'health',
	'agent/{id}',
	'agent/{id}/card',
	'agent/{id}/feedback',
	'agent/{id}/reputation',
	'owner/{address}'
];

/** Prompts — slash workflows. */
export const PROMPTS = [
	{ name: '/find-and-vet-agent', note: 'flagship' },
	{ name: '/vet-agent', note: '' },
	{ name: '/compare-agents', note: '' },
	{ name: '/prepare-x402-call', note: 'stops before signing' },
	{ name: '/explore-registry', note: '' }
];

/** The four invariants CI enforces — see CONTRIBUTING.md. */
export const INVARIANTS = [
	{
		title: 'Read-only and keyless',
		body: 'No signer, no write clients, no private keys anywhere under src/. STELLAR_PRIVATE_KEY is ignored on purpose and warned about on stderr. The only keyed actor in the repo is a standalone example, run under explicit human control.'
	},
	{
		title: 'stdout is JSON-RPC only',
		body: 'Every log and diagnostic goes to stderr, so the protocol stream is never corrupted by a stray print.'
	},
	{
		title: 'Agent text is data, never instructions',
		body: 'Names, descriptions, service labels and feedback tags live only in labeled selfDeclared slots of the structured output — sanitized (control, zero-width and bidi characters stripped) and length-bounded. Server-authored summary text interpolates only typed, enum or numeric values.'
	},
	{
		title: 'Degrade closed',
		body: 'Data precedence is explorer → on-chain verify → declared-only. When the chain read fails, the result is labeled unavailable rather than quietly presented as verified.'
	}
];

/** Canonical client bootstrap examples; docs/integration.md retains manual configs. */
export const CONFIGS: { id: string; label: string; lang: string; code: string; note: string }[] = [
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
