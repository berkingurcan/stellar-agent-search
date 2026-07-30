# P3-11 — Remote / stateless deployment

**Owner:** Code + Ops · **Status:** implemented locally; deploy/canary blocked

## Outcome so far

The remote adapter is no longer a speculative stretch. `worker/src/index.ts` implements the same read-only
tool/resource/prompt surface with Cloudflare Agents `0.20.1` `createMcpHandler` and the split MCP v2 server.
It creates a fresh server per request, uses automatic response mode with a stateless legacy compatibility
lane, and holds no sessions.

It is **not deployed**. `https://mcp.stellar8004.com/mcp` currently reaches the landing assets Worker and
returns 404. No production availability, interoperability, performance, or MCP `2026-07-28` conformance claim
is made yet. Offline tests cover modern `server/discover` plus its per-request `_meta` envelope and the legacy
stateless `initialize` lane; MCP v2 intentionally does not use `initialize` for `2026-07-28`. Local stdio
remains the supported path and currently negotiates protocol `2025-11-25`.

## Chosen topology

- The assets-only `stellar-agent-search-web` Worker owns the `mcp.stellar8004.com` custom domain.
- The separate `stellar-agent-search` runtime Worker declares exact zone routes for `/mcp` and `/healthz`.
  Cloudflare evaluates those more-specific routes before the custom-domain origin, leaving all other paths on
  the landing Worker.
- `workers.dev` and preview URLs are disabled on both surfaces.
- The Worker build/deploy workspace requires Node `^22.18.0` or `>=24.11.0`; the local/published CLI runtime
  requires Node ≥ 22.
- The runtime's ExplorerService calls the existing `stellar8004-web` Worker only through the
  `STELLAR8004_API` Service Binding. It has no Supabase credentials, no direct database path, and no shadow
  indexer. The existing Supabase-backed index remains canonical.

The architectural and upstream ownership contract is documented in
[docs/stellar8004-integration.md](../docs/stellar8004-integration.md). The scalable cursor discovery endpoint
is proposed in [trionlabs/stellar-8004#18](https://github.com/trionlabs/stellar-8004/issues/18); filing that
issue does not mean the API is accepted or shipped.

## Implemented controls

- canonical Host + browser Origin allowlists; originless MCP clients allowed (CORS is not authentication)
- public, read-only, keyless, deliberately unauthenticated endpoint
- `POST`-only `/mcp`, JSON content type, actual streamed-body cap of 256 KiB, batch cap of 8
- conservative Service Binding-call cap of 24, preserving headroom under Cloudflare's maximum Worker
  invocation chain of 32; Soroban verification RPC is separately bounded/cached
- cost-weighted, PoP-local best-effort rate limiter configured for 30 units/minute
- Service Binding egress restricted to `GET` and `/api/v1` or `/api/v2`; caller auth/cookies/forwarding/MCP
  headers stripped; agent-declared endpoints never fetched
- shared isolate-local Explorer and verifier TTL caches; optional PoP-local Cache API reuse only for explicitly
  public, cookie-free upstream `200` responses, with actor-specific `x-ratelimit-*` headers stripped
- shallow `/healthz` that performs no upstream checks
- all three Stellar SDK imports aliased to the fetch-based `no-axios` build for the Worker bundle

These controls are defense in depth, not stronger claims: the limiter is neither global nor exact and fails
closed with 503 if unavailable; it is keyed only by the edge-owned IP, so user-agent rotation cannot mint
new buckets while NAT peers can share one; the caches are
neither global nor correctness sources; Host/Origin/CORS do not authenticate a direct client; the cost
estimator cannot prove a future dependency will never alter its call pattern. OAuth is unnecessary for data
confidentiality here, but remains a real future option for durable abuse attribution, revocation, or quotas.

## Blocking gates

1. Replace rate-limit `namespace_id: "0"` in `worker/wrangler.jsonc` with an integer unique to the Cloudflare
   account. The deploy script intentionally refuses the sentinel.
2. Run the remote persisted-secret gate and require an empty result or the reviewed checked-in safe allowlist.
   `wrangler.jsonc` is not sufficient evidence because Wrangler preserves secrets added through the dashboard
   or API. Any auth/network/output error blocks deploy; only the separate first-deploy command accepts
   Wrangler's exact missing-Worker response.
3. Perform a controlled route deploy and prove with two distinguishable clients that the original caller
   identity reaches `stellar8004-web` through the reconstructed bodyless Service Binding request. Merely
   deriving downstream `cf-connecting-ip` and `x-real-ip` from Cloudflare's edge-owned incoming header in
   offline tests is not production proof.
4. Canary Host/Origin rejection, modern `server/discover`, legacy `initialize`, tool listing, a bounded read,
   over-limit body/batch/cost cases, the shallow health response, cache behavior, logs/traces, and rollback of
   both exact routes.
5. Record the canary before advertising the URL or adding remote copy-paste configs.

The deployment should be stopped and the two runtime routes removed if caller identities collapse to one
upstream quota, if the handler negotiates differently from the tested protocol lanes, or if the bundle scan
finds the real axios package or concrete signer/key/write wiring. The no-axios SDK bundle legitimately carries
fetch-backed `feaxios` names and latent contract-client signing methods; broad string matches are not proof of
a wired signer.

See [docs/architecture.md](../docs/architecture.md#remote-cloudflare-adapter-implemented-not-live) and
[SECURITY.md](../SECURITY.md#hosted-worker-boundary-implemented-not-deployed) for the full runtime and threat
boundaries.
