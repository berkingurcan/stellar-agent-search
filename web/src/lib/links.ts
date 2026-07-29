/**
 * Canonical public URL, for <link rel="canonical"> and og:url.
 *
 * MUST match the `routes` pattern in wrangler.toml — if they drift, the page
 * advertises an address it is not served at.
 *
 * A subdomain of the explorer's own zone, not a neutral host: the registry this
 * server indexes IS the explorer at EXPLORER, and the gap being closed is that the
 * registry is unreachable outside it, so the discovery layer belongs at the same
 * name. See wrangler.toml for why this is a subdomain rather than a /mcp path.
 */
export const SITE = 'https://mcp.stellar8004.com';

export const GITHUB = 'https://github.com/berkingurcan/stellar-agent-mcp';
export const NPM = 'https://www.npmjs.com/package/stellar-agent-mcp';
export const EXPLORER = 'https://stellar8004.com';
export const SDK_DOCS = 'https://stellar8004.com/developers';
export const MCP_SPEC = 'https://modelcontextprotocol.io';
export const PAPER = 'https://arxiv.org/abs/2606.26028';
