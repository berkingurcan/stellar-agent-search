# Remote Worker release gate

The remote runtime is not live. The code and exact routes are ready, but a
release is blocked until the rate-limit namespace is replaced and the deployed
Service Binding path preserves distinct caller identities.

## Preconditions

1. Keep `stellar8004-web` as the only Supabase/indexer owner. This Worker gets
   an HTTP Service Binding only; it never receives Supabase credentials.
2. Replace `namespace_id: "0"` with an account-unique positive integer. The
   fail-closed predeploy check rejects the sentinel, duplicate bindings, broad
   routes, public previews, or an axios-capable Stellar SDK alias.
3. Record the currently active Worker version and a rollback target before any
   route change. Cloudflare rollbacks immediately replace the active version;
   they do not roll back bound resources.
4. Prefer a candidate version at 0% plus a version-override canary whenever an
   existing safe version is available. The override is accepted only when
   `/healthz` returns the candidate UUID in `x-worker-version`.

Local gates:

```bash
npm --prefix worker run predeploy
npm --prefix worker run typecheck
npm --prefix worker test
npm --prefix worker run dry-run
```

## Canary

Run this command from two physically distinct network clients (for example a
home connection and a mobile connection), changing only `--client-label`:

```bash
node worker/scripts/canary.mjs \
  --version-id CANDIDATE_WORKER_VERSION_UUID \
  --client-label home
```

The script proves the version override, shallow health, MCP initialization, and
one uncached `get_registry_health` call through the Explorer Service Binding.
The MCP probe sends `Cache-Control: no-cache`; the Worker gives it request-local
cache state, bypasses Cache API, and rejects MCP tool-level error results. It
does **not** claim to prove caller identity. Compare the two short canary
windows in `stellar8004-web` logs and require distinct trusted
`CF-Connecting-IP`/rate-limit actors. A label or User-Agent is not acceptable
evidence because the caller controls both.

Also verify:

- `GET /mcp` is rejected and `POST /mcp` accepts only the approved host,
  origin, media type, body size, batch size, and cost envelope;
- `/healthz` remains shallow and makes no Explorer, Supabase, RPC, or limiter
  call;
- a second call can use a public cache hit without replaying upstream
  `X-RateLimit-*` headers;
- two separate clients do not collapse onto one upstream quota identity;
- no command, documentation, or landing page advertises the remote URL before
  the evidence is recorded.

## Promotion and rollback

Promote only after both client records and upstream evidence are attached to
`issues/P3-11-remote-stateless-deployment.md`. If any gate fails, keep the
candidate at 0% or restore the recorded stable UUID:

```bash
npm exec wrangler -- rollback STABLE_WORKER_VERSION_UUID \
  --config worker/wrangler.jsonc \
  --message "rollback failed stellar-agent-mcp canary"
```

If this is the first runtime deployment and no stable runtime version exists,
the two exact routes must be removed/restored to the landing Worker rather than
pretending a code rollback can recover routing. Confirm that `/mcp` again
returns the landing response before closing the incident.

References: [Cloudflare rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/),
[version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/),
[Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), and
[rate-limit namespaces](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
