# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`get_provider_manifest`** (CLI `manifest <id>`): the Provider Standard v1 (`stellar-agent-services/provider@1`)
  step between discovery and payment. For one agent it finds the manifest its registration names
  (`{ name: "stellar-agent-services", version: "1" }`), fetches it the way the standard tells clients to (public
  HTTPS host, no redirect, at most 256 KiB, `application/json`, I-JSON), and returns:
  - `offer`: each service's price in base units and whole USDC, charge mode, expected duration and capacity, the
    network, asset, `payTo` and payment window, and result retention for job recovery. Every field shown is checked
    against the standard, and a manifest whose payment terms can't be read exactly is `invalid` and shows none. A
    manifest for another network than the server's is refused.
  - `identity` / `identityBound`: rules [I1]–[I3]. The registration names this manifest, the manifest names this
    agent, and `payTo` is the agent's on-chain wallet. Over the explorer the registration is read again from the
    Identity contract, so the indexer never decides whom a user pays.
  - `conformance`: badges (Standard v1, Payment verified, Recovery verified) from Stellar 8004 Validation Registry
    records with tag `provider-standard-v1`, counted only for validators in the new `TRUSTED_VALIDATORS` setting and
    never for the agent's own owner or wallet. Any failed read makes it `unavailable`, never a partial set.
  - Provider text (names, descriptions, titles, tags, URLs) only in the sanitized `selfDeclared` slot.

  It works in explorer and registry mode, and never pays. `test/provider-standard.test.ts` runs the manifest reader
  over the standard's own test vectors (`test/fixtures/provider-standard/manifests.json`).
- **`TRUSTED_VALIDATORS`** (CLI `--trusted-validators`, `setup --trusted-validators`): up to 20 checksummed G… or
  C… validator addresses whose Validation Registry records earn badges. Empty by default, and then the registry is
  not read.
- `list_services` rows carry `providerStandard: true` for an entry that declares a Provider Standard v1 manifest,
  and the summary says how many do. The `find-and-vet-agent` and `prepare-x402-call` prompts call
  `get_provider_manifest` for those providers and drop any that is not `ok` or not identity-bound.
- **AI-agent onboarding**: `AGENTS.md` (read by Codex, Cursor, Copilot and others; `CLAUDE.md` and `GEMINI.md`
  import it) routes an agent visiting the repo to the right doc for using, integrating, building a provider, or
  contributing. `llms.txt` is the same index as plain links, also served by the landing site.
  `test/agent-docs.test.ts` fails on a dead link or a drifted copy.
- **Provider guide** `docs/build-a-discoverable-agent.md`: the registration file, how `find_agent` matches and
  ranks an agent, x402 and feedback expectations, and a pre-launch checklist. It registers without a secret key
  through Stellar Agent Services' `provider-kit register`, approved in the provider's own wallet;
  `examples/provider-register.ts` remains for other services.
- `examples/provider-register.ts` (registers an agent with `@trionlabs/stellar8004`; testnet and dry run by
  default) and `examples/consumer-mcp-client.ts` (calls `find_agent` from your own program over stdio).
- **Registry mode** (`REGISTRY_AGENT_IDS`, CLI `--registry-agent-ids`, `setup --registry-agent-ids`): discovery
  that reads an operator allowlist of agents straight from the Identity contract (`agent_uri`,
  `get_agent_wallet`, `find_owner`, keyless simulations on the fetch-only transport) and decodes each
  `data:`/`https:` registration file into the same `AgentProfile` the explorer path builds. It gives testnet a
  data source on its own chain without an indexer. `find_agent`, `list_services`, `list_agents`, `rank_agent`,
  `get_agent_profile`, `get_agent_card` and `verify_reputation` work over the allowlist and attach a `source`
  note saying reputation is not indexed. `leaderboard`, `get_registry_stats`, `get_registry_health`,
  `get_agents_by_owner`, `get_agent_feedback`, owner-address `resolve_agent`, and `minExplorerScore` filters
  (an argument or a stated number) return the new `INDEXER_REQUIRED` error code instead of partial data. A
  score implied by a word like "best" or "trusted" is not applied in this mode, and coverage carries
  `implied-score-filter-not-applied`, so those common phrasings still search.
- `AgentSource` (`src/lib/source.ts`): the interface tools, resources and the CLI read through. Indexer-only
  reads are reachable only via `requireIndexer`. `ToolDeps.explorer` is now `ToolDeps.source`.
- CI checks for the MCP surface and registry mode:
  - `test/mcp-surface.test.ts` pins the instructions, tool schemas, prompts and resources in
    `test/__surface__/mcp-surface.json`. The new `MCP surface` workflow compares a PR's snapshot with `main`'s and
    fails on a change that would break an existing client (`scripts/ci/surface-compat.mjs`), unless the PR is
    labeled `breaking-change`.
  - `test/stdio-registry-mode.test.ts` runs registry mode through the built binary: the startup refusals and their
    exit code, the instructions, indexer-only tools refusing, an unreadable allowlist failing closed, and stdout
    staying JSON-RPC-only.
  - `test/registry-mode.test.ts` runs every tool in registry mode and fails when the README, the skill, the
    error-code table, the server instructions or `doctor` name a different set of indexer-only tools.
  - `Testnet smoke` (nightly and on demand) runs registry mode against the live testnet
    (`scripts/ci/testnet-smoke.mjs`); `Mainnet parity` (manual) compares two builds' answers on live mainnet
    (`scripts/ci/mainnet-parity.mjs`).

- `CONTRIBUTING.md` — contribution notes, project layout, and the four enforced invariants.
- This changelog.
- CI / npm / license badges in the README.
- `docs/evidence.md` — deliverable-to-evidence map for reviewers.
- `docs/recordings.md` — shot-by-shot scripts for the demo recordings.
- `ReputationVerifier.probe()` — an uncached read that reports *why* a verification produced no value
  (`disabled` / `truncated` / `contract-error` / `out-of-range` / `rpc-error`).
- `test/skill-sync.test.ts` — fails the build when `skills/mcp/SKILL.md` drifts from `src/`: tool, resource and
  prompt counts, unregistered tools/resources/prompts cited by the skill, registered tools it fails to document,
  and its version pin. The skill is fetched off the default branch by `npx skills add`, so drift reaches users
  with no release step in between.
- `repository`, `homepage`, `bugs`, and `keywords` in `package.json`. npm binds provenance attestations to
  `repository.url`, so publishing under Trusted Publishing would have failed without it.
- `test/version-sync.test.ts` — fails the build when the MCP SDK version advertised in the `doctor` banner, the
  README badge and prose, `docs/architecture.md`, or the sample output in `docs/getting-started.md` drifts from
  the pinned dependency, and checks the advertised spec date against the SDK's own `LATEST_PROTOCOL_VERSION`.
- `test/onchain-constants.test.ts` — asserts the USDC SAC address and CAIP-2 chain id the AgentCard advertises
  match `@x402/stellar`'s published constants. Those two values tell an A2A/AP2 client which asset on which
  chain to pay, so a hand-copied address that drifts sends a real payment to the wrong contract.
- `stellar-agent-search setup` — an idempotent bootstrap for Claude Code, Cursor, and Codex with `user`/`project`
  scopes, non-mutating `--check` and `--dry-run` modes, machine-readable `--json`, and an optional live MCP
  handshake that lists all tools. Existing conflicting registrations are reported, never overwritten; Codex
  project scope emits exact manual TOML because its CLI cannot persist that scope.
- MCP SDK v2 (`@modelcontextprotocol/server` + `@modelcontextprotocol/client` `2.0.0`, Zod 4) with one
  request-neutral `buildServer()` factory shared by local stdio and edge transports. The v1 monolithic SDK is
  retained only as a development peer required by Cloudflare's Agents adapter; application source never
  imports it.
- A separate Cloudflare Streamable HTTP Worker for `/mcp` and `/healthz`. The landing assets Worker continues
  to own `mcp.stellar8004.com`; exact zone routes select the runtime Worker only for those two paths. Registry
  reads cross a Service Binding to the existing `stellar8004-web` API — there is no direct Supabase client,
  service-role key, or second indexer.
- A versioned upstream discovery contract and rollout plan in `docs/stellar8004-integration.md`, filed as
  [`trionlabs/stellar-8004#18`](https://github.com/trionlabs/stellar-8004/issues/18). Until upstream accepts and
  ships it, bounded v1 scans expose explicit coverage metadata instead of pretending to be globally complete.
- Strict x402 dry-run and funded-run preflights: pinned agent/payee/network/asset/price, no permissive fallback
  retry, transaction/result hash validation, and feedback validation. A dry run spends nothing and cannot be
  presented as funded evidence.

### Security

- **Provider documents are the only agent-chosen URLs the local server fetches, and the public Worker fetches
  none.** `get_provider_manifest` reads a registration's manifest (and, over the explorer, the registration file)
  with one HTTPS `GET` each: no redirect, a 10 s deadline, a size cap, and IP-literal, `localhost`, single-label and
  `.local`/`.internal` hosts refused before any request (`src/lib/http.ts`). The Worker's tool policy
  (`fetchProviderDocuments: false`) leaves the tool out, so its egress stays the Explorer binding and RPC.
  `SECURITY.md` T7 is updated.

- **On-chain reads no longer use axios.** `ReputationVerifier` now talks to the Reputation contract through
  `@stellar/stellar-sdk/no-axios/contract` (fetch-based), reusing the generated bindings' `Spec` so argument
  encoding and result decoding are unchanged — see `src/lib/soroban.ts`. Unlike the `overrides` below, this
  **does** reach consumers of the published package: verified by uninstalling the override, leaving the
  vulnerable `axios@1.15.0` in the tree, and watching `doctor`'s bounded contract-reachability read pass through a proxy
  that previously answered `405`.
- `overrides: { "axios": "1.18.1" }` — `@stellar/stellar-sdk@15.1.0` pins axios to the exact version `1.15.0`,
  which carries two **high**-severity advisories. The override removes that vulnerable version from this
  repository's resolved graph. The same bump crosses the 1.16.1 proxy fix, so `doctor`'s contract reachability read, which
  previously failed with `405` behind a proxy, now passes. **Note:** npm applies `overrides` only from the root
  project, so this protects the repository and its CI, not consumers of the published package — see
  [docs/architecture.md](docs/architecture.md).
- `overrides: { "@hono/node-server": "^2.0.5" }` forces the patched line for the legacy SDK peer graph. The
  application uses neither its static-file handler nor the monolithic SDK at runtime, but the dependency graph
  is still patched rather than excused as unreachable.
- GitHub Actions are pinned to commit SHAs in CI and release workflows rather than mutable major-version tags.
- The release workflow checksum-pins `mcp-publisher` `v1.8.0` instead of downloading `latest`, and generates a
  CycloneDX SBOM from a clean consumer install of the exact packed artifact before publishing.
- The Trusted Publishing workflow installs exact `npm@11.17.0` rather than executing a moving `npm@latest`.
- Persistent MCP client registrations created by `setup` pin the exact running package version instead of
  executing a mutable npm `latest` tag on every launch. The public landing withholds copyable install commands
  while the npm name remains unclaimed.
- Release publishing now requires main-branch ancestry, the exact npm maintainer allowlist, a schema-valid MCP
  manifest, and one packed tarball shared by consumer-SBOM generation and `npm publish`. A published version is
  skipped only when its integrity and GitHub OIDC/SLSA provenance match the tagged commit; immutable MCP
  Registry versions receive the same exact-metadata precheck. Publisher credentials are removed on every exit.

### Changed

- Ranking now uses the versioned `stellar-agent-search-declared-evidence-v1` policy: normalized indexed quality
  multiplied by a fixed evidence index (`0.4 × capped volume + 0.6 × effective breadth`). Owner-declared
  capabilities and verification state add zero points; there is no novelty floor. `rankVersion`,
  `evidenceStrength`, and `lowEvidence` make the semantics explicit. Mutable `RANK_W_*` settings and supplied
  `rank_agent.weights` are rejected. The ambiguous discovery input `minScore` is also rejected in favor of
  `minExplorerScore`, which names the upstream v1 `total_score` filter rather than implying a local-rank gate.
- The skill now ships from this repository at `skills/mcp/SKILL.md` (was `skill/SKILL.md`, destined for
  `trionlabs/stellar-8004`). Install with `npx skills add berkingurcan/stellar-agent-search --skill mcp`.
  Rationale: [docs/evidence.md §3](docs/evidence.md).
- The skill's `mcp-package-version` pin is `>=0.1.0`, not `^0.1.0`. A caret range on a 0.x package resolves to
  `>=0.1.0 <0.2.0`, so the pin would have excluded the next minor release.
- README and the getting-started guide now use the canonical `stellar-agent-search setup` bootstrap instead of
  hand-written client registration commands, and the guide documents the optional skill install it had been
  missing.
- The tag release workflow now rejects tag/package/server version drift and resumes after npm publication only
  when the immutable version's owners, exact tarball integrity, Trusted Publisher identity, and GitHub SLSA
  source all match the locally gated release.
- The npm artifact is explicitly bin-only. The old `main`/`module`/`types`/`exports` fields pointed imports at
  the CLI entry, whose top-level dispatch starts a process instead of exposing a library API. SDK ownership
  remains with `@trionlabs/stellar8004`; this package now advertises only the executable it actually supports.

### Fixed

- The hosted Worker now reads `REGISTRY_AGENT_IDS` so its canonical-config check can refuse it (503).
  Before this, the Worker never passed the variable to its config, so the "never registry mode" guard
  could not fire, and a Worker with an allowlist set would have served the mainnet explorer anyway.
  The deploy validator already kept the variable out of `wrangler.jsonc`.
- `doctor` in registry mode now lists registry health among the tools that need an indexer, as the
  server instructions and docs already did.

- Cached contract-probe results retain the timestamp of the actual Soroban read. A 10-minute-old cache
  hit no longer rewrites `verification.checkedAt` to the current response time and masquerades as fresh.

- **`examples/x402-demo.ts` demanded a facilitator credential it never uses.** `X402_API_KEY` was a *fatal*
  mainnet preflight check, so a funded run would have aborted before money moved over a value nothing in the
  file reads — this client signs the payment locally and submits it as a header, and the resource server
  settles with whichever facilitator it chose. Confirmed against the live challenge from
  `scrapper.stellar8004.com`, which names no facilitator. The check is gone; the variable stays in the
  secret-exclusion assertion so a stray value still cannot reach the MCP subprocess.
- **The x402 demo signed whatever the 402 challenge asked for.** Only `network` was checked, but the resource
  server writes the whole challenge — `asset` and `amount` were equally under its control and
  `createPaymentPayload` would have signed them. The demo now also requires the asset to be the USDC SAC
  `@x402/stellar` publishes, refuses a `payTo` equal to the payer, and caps the price at `MAX_PRICE_USDC`
  (default `0.10`; the scrapper's live price is `0.0001`). The USDC address is now imported from
  `@x402/stellar` instead of re-typed — `src/` still hardcodes it to stay keyless, pinned by
  `test/onchain-constants.test.ts`.
- `examples/` and `test/` are now typechecked. `tsconfig.json` included only `src`, so `npm run typecheck` in
  CI never looked at the demo — the one file that spends real money. Adding them surfaced one latent error
  (`RequestInfo` in `test/explorer.test.ts` needs the DOM lib, which this project does not enable).
- `STELLAR_NETWORK=testnet` silently mixed two chains. The default explorer indexes mainnet only, but
  `STELLAR_NETWORK` also selects the Soroban contracts and RPC, so testnet gave mainnet registry rows with
  testnet on-chain reads and said nothing. It now **refuses to start** unless `EXPLORER_BASE_URL` is set
  explicitly — there is no public testnet indexer to fall back to, so a warning would have left the mixed
  result in place. The refusal is a `ConfigError`, printed as a plain `error:` line with exit code 2 rather
  than a stack trace, matching how a bad CLI flag already fails. The documented dry-run gate for the x402 demo
  is now `DRY_RUN=1` on mainnet, which spends nothing and exercises the path the funded run actually takes.
  (The x402 demo was never at risk — it compares the 402 challenge's network to the configured CAIP-2 id and
  aborts on a mismatch.)
- `doctor` reported a **failed** on-chain read as a passing check with the message "sampled agent #10 has no
  on-chain summary yet". It called `verify()`, which degrades closed to `null`, making a broken RPC path
  indistinguishable from an unrated agent — so a misconfigured environment showed green and exited 0. It now
  uses `probe()`, fails the check, prints the underlying cause, and exits non-zero. The degrade-closed contract
  that tools rely on is unchanged.
- The skill file listed 12 tools (there are 13) and documented a `stellar8004://search/{query}` resource that
  does not exist, plus two inaccurate resource descriptions. `test/skill-sync.test.ts` now makes this class of
  drift a red build.
- The skill declared `version: 1.0.0` against a `0.1.0` package.
- `docs/evidence.md` overstated three things a reviewer would have checked: that the skill ships inside the npm
  tarball (it does not — `files` excludes `skills/`, deliberately), that one-command skill acquisition was
  already verifiable (it needs the repo public and `main` as the default branch), and the automated test count.

### Planned 0.1.0 surface

Release-candidate surface for a read-only, keyless MCP server and CLI over the stellar-8004 registry on
Stellar mainnet. Version 0.1.0 has not been published yet.

### Added

**MCP tools (13, all read-only)**

- `find_agent` — natural-language discovery → ranked candidates.
- `rank_agent` — rank an explicit id set or a query, with the full declared-evidence breakdown and bounded
  contract-probe status.
- `get_agent_profile` — identity, capabilities, declared reputation, fail-closed probe status, recent feedback.
- `list_services` — catalog of invokable x402 / MPP service endpoints.
- `list_agents`, `leaderboard`, `resolve_agent`, `get_agents_by_owner`, `get_agent_feedback`,
  `verify_reputation`, `get_agent_card`, `get_registry_stats`, `get_registry_health`.

**MCP resources** — `stellar8004://` scheme: `registry`, `leaderboard`, `health`, `agent/{id}`,
`agent/{id}/card`, `agent/{id}/feedback`, `agent/{id}/reputation`, `owner/{address}`. Each returns a dual
JSON + rendered-markdown payload.

**MCP prompts** — `/find-and-vet-agent`, `/vet-agent`, `/compare-agents`, `/prepare-x402-call`,
`/explore-registry`. `prepare-x402-call` stops before signing; this server holds no keys.

**Fail-closed contract evidence** — the current read calls one bounded `get_clients_paginated` window only.
Because the contract exposes neither an authoritative client count nor an exhaustion cursor, the server does
not call `get_summary` or compare any Explorer reputation field. Attempted probes report `unavailable`, an empty
`verifiedFields`, and explicit limitations; skipped probes report `skipped`.

**Declared-evidence ranking** — versioned policy `stellar-agent-search-declared-evidence-v1` multiplies normalized
indexed quality by fixed evidence strength (`0.4 × capped volume + 0.6 × effective breadth`). Owner-declared
x402/MPP/service metadata and probe status add zero points. This is a heuristic over indexer-declared inputs,
not Sybil resistance, proof of personhood, or an authorization signal.

**Trust boundary** — server-authored prose interpolates only typed values, compile-enforced by the `serverText`
tagged template. Agent-authored free text is confined to labelled `selfDeclared` slots, sanitized (control,
zero-width, bidi, and line/paragraph separators stripped) and length-bounded.

**A2A-shaped projection** — `get_agent_card` emits a labeled, derived projection for interoperability work.
It is not fetched from an agent, does not establish endpoint/payment conformance, and is not presented as an
agent-signed or verified AgentCard.

**Human CLI** — `find`, `rank`, `profile`, `services`, `doctor`, plus the idempotent `setup` bootstrap for
Claude Code, Cursor, and Codex, with machine-readable output and live MCP handshake verification.

**Reference x402 loop** — `examples/x402-demo.ts` discovers an agent, pays its endpoint in USDC over x402, and
writes on-chain reputation feedback. The only keyed code in the repo; run manually.

**Distribution** — `server.json` (MCP Registry), `smithery.yaml`, `glama.json`, and `skills/mcp/SKILL.md` for
`npx skills add berkingurcan/stellar-agent-search --skill mcp`.

**Docs** — README, getting-started, architecture, full tool reference, and integration guides for 8 clients
(Claude Code, Cursor, Windsurf, Cline, VS Code, Claude Desktop, Codex CLI, Gemini CLI).

### Security

- Read-only and keyless by construction; `STELLAR_PRIVATE_KEY` is ignored if set, with a stderr warning.
- stdout carries JSON-RPC only — every log goes to stderr.
- Verification degrades closed: an unreachable RPC reports `unavailable`, never a declared figure relabelled as
  verified. An unrated agent never returns `verified`.
