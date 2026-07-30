# Publishing `stellar-agent-market`

Operational runbook for the one-time npm name reservation and every real release after it. The blocking work
is tracked in [`issues/`](issues/); this file is the ordered procedure.

**State verified 29 July 2026:** `berkingurcan` is the selected canonical GitHub owner, but the source still
lives in the private staging repository and `berkingurcan/stellar-agent-market` is not publicly accessible. The
npm name is unclaimed, the destination's `npm-production` environment is not configured, and
`NPM_PACKAGE_OWNERS` is unset. Move the private repository first, then reserve the npm name with the inert
bootstrap **before** making prepared commands public. Public onboarding stays disabled until both real
registries are verified.

**Mandatory first-release order:** private move to selected owner `berkingurcan` → inert `0.0.0` reservation under
the non-default `bootstrap` tag while private → public repository → protected OIDC real release.

## Release model

Only the inert `0.0.0` name reservation is manual. It contains no executable code and is published under the
non-default `bootstrap` dist-tag. The real `0.1.0` and every later release are tag-driven through
`.github/workflows/publish.yml` using npm Trusted Publishing (GitHub OIDC, no long-lived npm token).

The workflow accepts only a tag whose commit is already on `origin/main`. It validates metadata against the
checksum-pinned MCP schema, typechecks, tests, builds, installs the exact tarball in a clean consumer, executes
its bin, generates the consumer SBOM, and verifies npm ownership, tarball integrity, and SLSA provenance. Only
then does it publish or verify the immutable MCP Registry version.

## 1. Finalize repository identity while it is still private

The permanent owner is **`berkingurcan`**. Move the repository to
`berkingurcan/stellar-agent-market` while both source and destination remain private, then run the owner-string
audit in [P0-01](issues/P0-01-make-repository-public.md). Prefer a GitHub transfer over a second disconnected
copy because it preserves history and repository settings. Do not expose the destination yet: the npm name is
still unclaimed and the prepared documentation contains exact future commands.

`npm run validate:release` now derives one canonical GitHub owner/repository from `package.json` and rejects
drift in `server.json`, the publish workflow, landing links, skill commands, security/docs links, or the MCP
namespace. The tag workflow independently requires runtime `GITHUB_REPOSITORY` to equal that same identity;
a GitHub redirect is not accepted as proof after a transfer.

## 2. Prepare a green release commit on `main`

Start from a clean checkout. Keep the release version synchronized in `package.json`, both `server.json`
version fields, and `skills/mcp/SKILL.md`'s `metadata.version`. Update `smithery.yaml` and every persistent
onboarding example to the same exact `stellar-agent-market@X.Y.Z` pin; never persist an unversioned npm launch.

```bash
npm ci
npm run validate:release
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Before tagging, reproduce [P1-06](issues/P1-06-published-package-ships-vulnerable-axios.md)'s locally green
downstream proof rather than trusting this repository's root `overrides`: pack with `--ignore-scripts`, install
that exact tarball in a new temporary npm project, run its `stellar-agent-market --version`, inspect `npm ls
--all`, and require `npm audit --omit=dev --audit-level=high` to pass. The current packed-consumer proof has no
high/critical finding; the issue's final checkbox remains open only so the immutable OIDC-published artifact is
checked again after release.

Date the changelog, merge the reviewed release commit to `main`, and wait for required CI. Do not tag a feature
branch or a dirty working tree.

For a later version bump, avoid `npm version`'s automatic tag until every manifest is synchronized:

```bash
npm version patch --no-git-tag-version  # or minor / major
# Update server.json, skill metadata, Smithery, pinned docs/web examples, and CHANGELOG.md.
npm run validate:release && npm run typecheck && npm test && npm run build
# Review and commit the complete release diff; create the tag only after it is green on main.
```

## 3. Reserve the npm name once — before public visibility

Do not rewrite the real package to `0.0.0`. Generate the repository-provided inert reservation in an empty
temporary directory:

```bash
bootstrap_dir="$(mktemp -d)"
node scripts/release/create-bootstrap-package.mjs "$bootstrap_dir"
npm pack --dry-run "$bootstrap_dir"
npm login
npm publish "$bootstrap_dir" --access public --tag bootstrap
npm view stellar-agent-market dist-tags --json
```

The dry run must contain exactly `package.json`, `README.md`, and `LICENSE`; it must contain no `bin`, scripts,
or dependencies. The dist-tags response must show `"bootstrap": "0.0.0"` and must not contain `latest`.
Delete the temporary directory. Never manually publish `0.1.0`. Do not make the repository public until this
reservation is independently visible under the intended npm owner; otherwise the public command strings
advertise an unclaimed executable namespace.

## 4. Make the canonical repository public

GitHub → Settings → General → Danger Zone → Change visibility → Public. This external identity change needs
the repository/organization owner's explicit action; it is not automated by this runbook.

The real public release requires public source for npm provenance and MCP Registry GitHub OIDC ownership. In a
logged-out session, confirm the canonical path selected in step 1. Do not retain the current personal owner
by accident:

```bash
canonical_owner='berkingurcan'
test "$canonical_owner" = 'berkingurcan'
curl -fsS "https://raw.githubusercontent.com/${canonical_owner}/stellar-agent-market/main/skills/mcp/SKILL.md" >/dev/null
```

Also re-check that `npm view stellar-agent-market dist-tags --json` still shows only the owned bootstrap and no
unexpected `latest` release.

## 5. Configure both protection layers

Create a GitHub environment named **`npm-production`**. Require a second reviewer, prevent self-review, allow
only selected tags matching `v*`, and disable administrator bypass. A workflow's `environment:` field alone
does not configure any of these rules.

On npmjs.com → package → Settings → Trusted Publisher, set:

- provider: **GitHub Actions**;
- organization/user: **`berkingurcan`**;
- repository: `stellar-agent-market`;
- workflow filename: **`publish.yml`** (filename only, not `.github/workflows/publish.yml`);
- environment name: **`npm-production`**;
- allowed action: **`npm publish`** only.

Set the GitHub Actions repository variable `NPM_PACKAGE_OWNERS` to the exact comma-separated npm maintainer
allowlist. The release fails if the variable is empty, an unexpected maintainer appears, or any existing npm
version points at another repository/MCP name.

After the first OIDC release succeeds, configure npm to require 2FA and disallow tokens, and revoke obsolete
automation tokens. Trusted Publishing continues to work through its short-lived OIDC credential.

## 6. Publish the real release by tag

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

## 7. Verify, then expose onboarding

```bash
npm view stellar-agent-market@0.1.0 version dist.integrity repository --json
npm view stellar-agent-market dist-tags --json
canonical_mcp_name_urlencoded="$(node -e "process.stdout.write(encodeURIComponent(require('./server.json').name))")"
curl -fsS "https://registry.modelcontextprotocol.io/v0.1/servers/${canonical_mcp_name_urlencoded}/versions/0.1.0"
```

On npm, verify that the provenance badge resolves to this repository, `.github/workflows/publish.yml`, the
release tag, and the tagged commit. Confirm the MCP Registry response matches `server.json`.

Only after both checks pass, make a reviewed follow-up that changes the single re-export in
`web/src/lib/install.ts` from `install-pending.js` to `install-published.js`, builds the site, runs
`npm --prefix web run check:release-surface`, and deploys the assets-only landing Worker. The pre-release
module graph contains no executable package commands; the published module supplies them only after this switch.
Canary every copy button. Persistent configs must stay pinned to
`stellar-agent-market@0.1.0`; do not replace them with mutable `latest` launches.

## Non-negotiable stop conditions

- The repository is private or the tag commit is not on `main`.
- The repository is about to become public while the npm name is still unclaimed.
- [P1-06](issues/P1-06-published-package-ships-vulnerable-axios.md) is open, or a clean install of the exact
  packed tarball reports a high-severity production advisory or more than one Stellar SDK major.
- The `npm-production` environment is missing any protection rule.
- `NPM_PACKAGE_OWNERS` is unset or does not exactly match the intended npm maintainer allowlist.
- npm Trusted Publisher uses a full path instead of filename `publish.yml`, omits the environment, or allows
  an action other than the intended `npm publish`.
- The bootstrap package contains executable code or creates `latest`.
- Any owner, integrity, provenance, registry object, or version check differs from the local gated release.
- The workflow proposes a manual real-version publish, an npm token, or an unversioned persistent `npx` command.
