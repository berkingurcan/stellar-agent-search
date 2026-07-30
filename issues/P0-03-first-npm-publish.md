# P0-03 — First npm publish + Trusted Publisher

**Owner:** Builder · **Phase A blocked by:** [01 phase A](P0-01-make-repository-public.md) (canonical
owner/transfer) · **Phase A blocks:** 01 phase B (public visibility) · **Phase B blocked by:** 01 phase B ·
**Blocks:** 05 · **Status:** resolved 30 July 2026 — `stellar-agent-search@0.1.0` is live on npm via the protected
OIDC workflow with verified provenance (`bootstrap: 0.0.0` reserved first), and the MCP Registry version `0.1.0`
is live and equal to `server.json` under the registry's schema-default normalization. The `v0.1.0` publish run
shows red on its final verify step only: the first attempt hit an npm attestation-propagation race, the re-run hit
the registry read-back lagging its own publish, and the tag-pinned comparator predates the normalization fix on
`main`, so that run can never turn green retroactively. The publication is verified directly:
`curl https://registry.modelcontextprotocol.io/v0.1/servers/io.github.berkingurcan%2Fstellar-agent-search/versions/0.1.0`
piped through `node scripts/release/verify-mcp-registry.mjs` prints an exact match. Future tags verify green

## Problem

`stellar-agent-search` has never been published. `npm view stellar-agent-search version` returns
`404 Not Found - GET https://registry.npmjs.org/stellar-agent-search`, so every `npx -y stellar-agent-search` in the
README, the skill, and the recording scripts currently fails.

External controls were also checked on 2026-07-29: GitHub returns `404` for the repository's
`npm-production` environment, the Actions-variable list is empty, and `NPM_PACKAGE_OWNERS` is therefore
unset. The workflow names these controls but cannot create or protect them; an organization/repository owner
must configure them before a real tag.

The tag-driven release path in `.github/workflows/publish.yml` cannot bootstrap itself: configuring a Trusted
Publisher on npmjs.com requires the package name to already exist.

## Fix

**Mandatory first-release order:** private move to selected owner `berkingurcan` → inert `0.0.0` reservation under
the non-default `bootstrap` tag while private → public repository → protected OIDC real release.

### 1. Reserve the name without creating a fake `latest`

Validate a green `main` checkout, then generate a deliberately inert reservation package in an empty
temporary directory. It contains only `package.json`, `README.md`, and `LICENSE`: no bin, scripts, or
dependencies. Its own `publishConfig.tag` is also `bootstrap`, so forgetting the CLI flag cannot create
`latest` accidentally.

Do this after the canonical GitHub owner is finalized but while the repository is still private. The source
already contains exact future commands; public visibility must not advertise an unclaimed executable npm name.

```bash
npm ci
npm run validate:release
npm run typecheck
npm test
npm run build

bootstrap_dir="$(mktemp -d)"
node scripts/release/create-bootstrap-package.mjs "$bootstrap_dir"
npm pack --dry-run "$bootstrap_dir"   # exactly three files; no executable code
npm login
npm publish "$bootstrap_dir" --access public --tag bootstrap
npm view stellar-agent-search dist-tags --json
```

The generator refuses a path inside this repository, a non-empty directory, an unexpected package identity,
or a source tree itself set to `0.0.0`. Confirm the output contains `"bootstrap": "0.0.0"` and no `latest`
entry, then delete the temporary directory. Do **not** manually publish `0.1.0`.

### 2. Make the canonical source public, then protect the OIDC publisher

After the inert reservation is independently visible under the intended npm owner and has no `latest` tag,
complete [P0-01 phase B](P0-01-make-repository-public.md): make the final canonical repository public and
verify it from a logged-out session. Do not configure or invoke the real release against a private or temporary
repository identity.

Create the GitHub environment **`npm-production`** and configure all of these rules; referencing an environment
from YAML does not configure protection by itself:

- require a second reviewer and prevent self-review;
- allow only selected tags matching `v*`;
- disable administrator bypass.

This intentionally means a solo maintainer needs a second trusted repository reviewer before releasing. On
npmjs.com configure the package's Trusted Publisher with:

- provider: GitHub Actions;
- owner/repository: **`berkingurcan/stellar-agent-search`**, the canonical path selected in
  [01](P0-01-make-repository-public.md);
- workflow filename: **`publish.yml`** — filename only, not `.github/workflows/publish.yml`;
- environment name: **`npm-production`**;
- allowed action: **`npm publish`** only.

Set the repository Actions variable `NPM_PACKAGE_OWNERS` to the exact comma-separated npm maintainer allowlist.
Then push `v0.1.0` from a green commit already on `main`. After this first OIDC release succeeds, set npm
publishing access to require 2FA and disallow tokens, then revoke any obsolete automation token.

Do not create that tag while [P1-06](P1-06-published-package-ships-vulnerable-axios.md) is open. The exact
packed tarball must first install in a clean consumer with one Stellar SDK major and pass
`npm audit --omit=dev --audit-level=high`; repository-root `overrides` are not downstream evidence.

`package.json` already carries `repository`, `homepage`, `bugs`, and `keywords`; npm binds the provenance
attestation to `repository.url`, and `npm publish --dry-run` does not exercise attestation generation, so this
first OIDC release is where a missing provenance field would surface. The workflow validates the exact packed
artifact, executes its installed bin in a clean consumer, generates its SBOM from that consumer graph, checks
the exact npm owner/repository/integrity/SLSA source, and then publishes `server.json` to the MCP Registry.

A rerun does not trust `HTTP 200`: an existing npm version is accepted only when its tarball, Trusted Publisher,
and GitHub provenance match the locally gated release. An existing MCP Registry version is accepted only when
its `server` object exactly equals local `server.json`; any mismatch fails closed.

### 3. Verify first, then expose onboarding

Do not flip the landing page during the publish job. Once both registries are independently readable:

```bash
npm view stellar-agent-search@0.1.0 version dist.integrity repository --json
npm view stellar-agent-search dist-tags --json
canonical_mcp_name_urlencoded="$(node -e "process.stdout.write(encodeURIComponent(require('./server.json').name))")"
curl -fsS "https://registry.modelcontextprotocol.io/v0.1/servers/${canonical_mcp_name_urlencoded}/versions/0.1.0"
```

The command derives the URL-encoded namespace from the reviewed `server.json`; do not replace it with a
hand-maintained owner string. The local `package.json`,
`server.json`, workflow `EXPECTED_REPOSITORY_URL`, npm Trusted Publisher, and this endpoint must all agree;
do not retain the staging repository's MCP identity after the move.

Verify that npm's provenance badge names this repository, `.github/workflows/publish.yml`, tag `v0.1.0`, and
the tagged commit. Only then switch `web/src/lib/install.ts` from `install-pending.js` to
`install-published.js` in a reviewed follow-up, run `npm --prefix web run build` and
`npm --prefix web run check:release-surface`, deploy the assets-only landing Worker, and canary every copy
button. The pending module graph must contain no executable package command. Persistent launches remain pinned to
`stellar-agent-search@0.1.0`; publication is not permission to switch configuration back to mutable `latest`.

## Acceptance

- `npm view stellar-agent-search dist-tags --json` shows `bootstrap: 0.0.0` before the real release and does not
  expose the bootstrap as `latest`.
- After the tag workflow, `npm view stellar-agent-search version` prints `0.1.0`.
- The npm page shows the repository link and the provenance badge for `0.1.0`.
- The Actions run shows approval for `npm-production`; npm's Trusted Publisher names that same environment and
  `publish.yml`.
- `NPM_PACKAGE_OWNERS` is set to, and the workflow verifies, the exact intended npm maintainer allowlist.
- The exact packed tarball passes the clean-consumer dependency and high-severity audit gate from P1-06.
- The exact MCP Registry endpoint returns the same `server` object as local `server.json`.
- Only after those checks, the landing page exposes pinned install commands and removes the unclaimed warning.
- A subsequent `v*` tag publishes without a token.
