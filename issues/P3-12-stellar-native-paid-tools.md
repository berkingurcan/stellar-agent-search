# P3-12 — Stellar-native paid MCP tools

**Owner:** Blocked upstream · **Status:** deferred — out of SOW scope

## Idea

Expose a *paid* MCP tool — the server charges USDC per call over x402 — rather than only helping a client
discover and pay someone else.

## Why it is blocked on the obvious path

Cloudflare's Agents SDK ships exactly this as `withX402` / `paidTool`, and Cloudflare's platform documentation
lists Stellar among supported x402 networks. The MCP helper has not caught up. Reading
`agents@0.20.1`'s `dist/mcp/x402.d.ts` and `.js`:

```ts
type X402Config = {
  network: string;            // open — normalizeNetwork passes CAIP-2 through, "stellar:pubnet" is accepted
  recipient: `0x${string}`;   // EVM-only at the type level; a Stellar G… address does not typecheck
  facilitator?: FacilitatorConfig;
};
```

and `withX402` unconditionally calls `registerExactEvmScheme(resourceServer)` — the only scheme registration in
the file — while reading nothing from `cfg` but `.facilitator`, `.network` and `.recipient`. There is no hook to
register another scheme, so even casting past the type leaves a resource server that cannot verify or settle a
Stellar payment. The client side is likewise EVM-bound: `X402ClientConfig.account: ClientEvmSigner`.

**Note:** the blocker is `recipient` plus the hardcoded scheme registration — *not* the `network` field, which is
an open string.

## The unblocked path

x402 v2 is chain-agnostic (`type Network = ${string}:${string}`) and `@x402/stellar` ships the server half:
`ExactStellarScheme` from `@x402/stellar/exact/server`. Building the `@x402/core` resource server directly and
registering that scheme works — it is Cloudflare's one-line helper that is unavailable, not the capability.
