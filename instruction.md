# Publishing `stellar-agent-mcp`

Operational runbook for the one-time npm name reservation and every real release after it. The blocking work
is tracked in [`issues/`](issues/); this file is the ordered procedure.

**State verified 29 July 2026:** the npm name is unclaimed and the repository must become public before a
provenance-backed release. Public onboarding therefore stays disabled, and every prepared launch remains
exact-version pinned.

## Release model

Only the inert `0.0.0` name reservation is manual. It contains no executable code and is published under the
non-default `bootstrap` dist-tag. The real `0.1.0` and every later release are tag-driven through
`.github/workflows/publish.yml` using npm Trusted Publishing (GitHub OIDC, no long-lived npm token).

The workflow accepts only a tag whose commit is already on `origin/main`. It validates metadata against the
checksum-pinned MCP schema, typechecks, tests, builds, installs the exact tarball in a clean consumer, executes
its bin, generates the consumer SBOM, and verifies npm ownership, tarball integrity, and SLSA provenance. Only
then does it publish or verify the immutable MCP Registry version.

## 1. Make the repository public

GitHub → Settings → General → Danger Zone → Change visibility → Public.

This is a release gate: npm does not generate provenance for a public package built from a private repository,
and MCP Registry GitHub OIDC ownership must resolve the public repository. In a logged-out session, confirm:

```bash
curl -fsS https://raw.githubusercontent.com/berkingurcan/stellar-agent-mcp/main/skills/mcp/SKILL.md >/dev/null
```

## 2. Prepare a green release commit on `main`

Start from a clean checkout. Keep the release version synchronized in `package.json`, both `server.json`
version fields, and `skills/mcp/SKILL.md`'s `metadata.version`. Update `smithery.yaml` and every persistent
onboarding example to the same exact `stellar-agent-mcp@X.Y.Z` pin; never persist an unversioned npm launch.

```bash
npm ci
npm run validate:release
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Date the changelog, merge the reviewed release commit to `main`, and wait for required CI. Do not tag a feature
branch or a dirty working tree.

For a later version bump, avoid `npm version`'s automatic tag until every manifest is synchronized:

```bash
npm version patch --no-git-tag-version  # or minor / major
# Update server.json, skill metadata, Smithery, pinned docs/web examples, and CHANGELOG.md.
npm run validate:release && npm run typecheck && npm test && npm run build
# Review and commit the complete release diff; create the tag only after it is green on main.
```

## 3. Reserve the npm name once

Do not rewrite the real package to `0.0.0`. Generate the repository-provided inert reservation in an empty
temporary directory:

```bash
bootstrap_dir="$(mktemp -d)"
node scripts/release/create-bootstrap-package.mjs "$bootstrap_dir"
npm pack --dry-run "$bootstrap_dir"
npm login
npm publish "$bootstrap_dir" --access public --tag bootstrap
npm view stellar-agent-mcp dist-tags --json
```

The dry run must contain exactly `package.json`, `README.md`, and `LICENSE`; it must contain no `bin`, scripts,
or dependencies. The dist-tags response must show `"bootstrap": "0.0.0"` and must not contain `latest`.
Delete the temporary directory. Never manually publish `0.1.0`.

## 4. Configure both protection layers

Create a GitHub environment named **`npm-production`**. Require a second reviewer, prevent self-review, allow
only selected tags matching `v*`, and disable administrator bypass. A workflow's `environment:` field alone
does not configure any of these rules.

On npmjs.com → package → Settings → Trusted Publisher, set:

- provider: **GitHub Actions**;
- organization/user: `berkingurcan`;
- repository: `stellar-agent-mcp`;
- workflow filename: **`publish.yml`** (filename only, not `.github/workflows/publish.yml`);
- environment name: **`npm-production`**;
- allowed action: **`npm publish`** only.

Set the GitHub Actions repository variable `NPM_PACKAGE_OWNERS` to the exact comma-separated npm maintainer
allowlist. The release fails if the variable is empty, an unexpected maintainer appears, or any existing npm
version points at another repository/MCP name.

After the first OIDC release succeeds, configure npm to require 2FA and disallow tokens, and revoke obsolete
automation tokens. Trusted Publishing continues to work through its short-lived OIDC credential.

## 5. Publish the real release by tag

Create the tag only on the reviewed commit already present on `main`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The tag must equal `v` plus the package/server version. The protected environment approval happens before the
job receives permission to publish. A rerun may skip an immutable npm version only after proving that its
owners, exact tarball integrity, Trusted Publisher, workflow/ref/commit, and Sigstore attestations match this
release. It never treats a bare `HTTP 200` as ownership.

The MCP Registry step performs the same fail-closed check: an existing exact version is accepted only when its
`server` object exactly equals local `server.json`.

## 6. Verify, then expose onboarding

```bash
npm view stellar-agent-mcp@0.1.0 version dist.integrity repository --json
npm view stellar-agent-mcp dist-tags --json
curl -fsS 'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.berkingurcan%2Fstellar-agent-mcp/versions/0.1.0'
```

On npm, verify that the provenance badge resolves to this repository, `.github/workflows/publish.yml`, the
release tag, and the tagged commit. Confirm the MCP Registry response matches `server.json`.

Only after both checks pass, make a reviewed follow-up that changes `PACKAGE_PUBLISHED` in
`web/src/lib/surface.ts` from `false` to `true`, removes the dated unclaimed-package warnings, and deploys the
assets-only landing Worker. Canary every copy button. Persistent configs must stay pinned to
`stellar-agent-mcp@0.1.0`; do not replace them with mutable `latest` launches.

## Non-negotiable stop conditions

- The repository is private or the tag commit is not on `main`.
- The `npm-production` environment is missing any protection rule.
- npm Trusted Publisher uses a full path instead of filename `publish.yml`, omits the environment, or allows
  an action other than the intended `npm publish`.
- The bootstrap package contains executable code or creates `latest`.
- Any owner, integrity, provenance, registry object, or version check differs from the local gated release.
- The workflow proposes a manual real-version publish, an npm token, or an unversioned persistent `npx` command.
