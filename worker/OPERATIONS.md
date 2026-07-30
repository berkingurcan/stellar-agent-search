# Remote Worker release gate

The remote runtime is not live. The code and exact routes are ready, but a
release is blocked until the rate-limit namespace is replaced and the deployed
Service Binding path preserves distinct caller identities.

## Preconditions

1. Keep `stellar8004-web` as the only Supabase/indexer owner. This Worker gets
   an HTTP Service Binding only; it never receives Supabase credentials.
2. Replace `namespace_id: "0"` with an account-unique positive integer. The
   fail-closed predeploy check rejects the sentinel, duplicate bindings, broad
   routes, public previews, or any module alias. Stellar SDK v16's default
   `./contract` and `./rpc` exports are fetch-based; the dry-run command also
   scans the emitted Worker and rejects axios implementation code.
3. Keep `deploy-secret-allowlist.json` empty unless a specific non-credential
   secret binding has been separately reviewed. Predeploy runs Wrangler's
   remote `secret list --format json` because normal deploys preserve secrets
   previously added through the dashboard/API even when they are absent from
   `wrangler.jsonc`. Any auth, network, command, output-schema, or unexpected
   secret result blocks deployment.
4. Record the currently active Worker version and a rollback target before any
   route change. Cloudflare rollbacks immediately replace the active version;
   they do not roll back bound resources.
5. Prefer a candidate version at 0% plus a version-override canary whenever an
   existing safe version is available. The override is accepted only when
   `/healthz` returns the candidate UUID in `x-worker-version`.

Local gates:

```bash
npm --prefix worker run predeploy
npm --prefix worker run typecheck
npm --prefix worker test
npm --prefix worker run dry-run
```

`npm --prefix worker run deploy` re-runs both the static config gate and the
remote persisted-secret gate automatically. Wrangler returns a non-zero
"Worker not found" result instead of `[]` before the first deployment; the
normal deploy command therefore stops. Only for a reviewed first deployment,
use `npm --prefix worker run deploy:first`. That separate command accepts the
exact missing-Worker result, but still rejects auth/network failures and runs
the same empty/allowlisted-secret policy. Do not use `deploy:first` after a
Worker exists, and do not bypass these scripts with a direct Wrangler deploy.

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
  --message "rollback failed stellar-agent-market canary"
```

If this is the first runtime deployment and no stable runtime version exists,
the two exact routes must be removed/restored to the landing Worker rather than
pretending a code rollback can recover routing. Confirm that `/mcp` again
returns the landing response before closing the incident.

After a first deployment, immediately run the normal predeploy command and
record that the remote secret list is empty. If any secret was ever added,
delete it deliberately and verify the empty list; uploading code alone does
not prove removal because Wrangler preserves persisted secrets.

References: [Cloudflare rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/),
[version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/),
[Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), and
[rate-limit namespaces](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
