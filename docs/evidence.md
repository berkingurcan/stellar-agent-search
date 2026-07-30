# Evidence package — Instawards SOW

**Project:** Stellar Agent Search (Stellar 8004 agent discovery)
**Builder / Team:** Algoria Team
**Ambassador Chapter:** Stellar Türkiye

This page maps each SOW deliverable to its evidence and gives a step-by-step way to verify it. It is written for
a reviewer **without** a technical background: everything in [§0](#0-five-minute-verification-no-install) can be
checked in a browser in about five minutes.

**Status legend:** ✅ shipped and verifiable · 🟡 built, awaiting a mainnet run or recording · ⬜ not yet produced

> Items marked `‹fill in›` are links that only exist after a publish or recording step. They are listed here so
> the reviewer can see exactly what is outstanding rather than having to infer it.

> [!IMPORTANT]
> **Release state (verified 30 July 2026):** the repository is public under the canonical owner
> `berkingurcan`, and `stellar-agent-search@0.1.0` is live on npm — published from tag `v0.1.0` through the
> protected OIDC workflow, with Sigstore provenance naming this repository, `publish.yml`, and the tagged
> commit. The MCP Registry version `0.1.0` is **live** and returns a server object equal to `server.json`
> (modulo the registry's own schema-default normalization, which the verify script now accounts for). The
> `v0.1.0` publish run itself shows red on its final verify step: the registry's read-back lagged the
> publish inside the poll window, and a re-run cannot go green because the tag-pinned comparator predates
> the normalization fix — the publication is verified directly instead (`curl` the version endpoint and run
> `node scripts/release/verify-mcp-registry.mjs` on the response). What remains for the SOW itself is the
> funded mainnet run (Deliverable 2) and the three recordings.

**Mandatory first-release order:** private move to selected owner `berkingurcan` → inert `0.0.0` reservation under
the non-default `bootstrap` tag while private → public repository → protected OIDC real release.

---

## 0. Five-minute verification (no install)

| # | What to check | Where | Expected |
|---|---|---|---|
| 1 | The code is public and MIT-licensed | [github.com/berkingurcan/stellar-agent-search](https://github.com/berkingurcan/stellar-agent-search) | Repository opens; `LICENSE` says MIT |
| 2 | Automated tests pass | Repo → **Actions** tab | Latest CI run green across Node 22/24 on Linux + macOS, plus the Worker job |
| 3 | The four SOW tools exist and are documented | [docs/tools.md](tools.md) | `find_agent`, `rank_agent`, `get_agent_profile`, `list_services` each documented with inputs and outputs |
| 4 | The x402 reference script exists | [examples/x402-demo.ts](../examples/x402-demo.ts) | TypeScript file in `/examples`, as the SOW specifies |
| 5 | The registry data is real | [stellar8004.com](https://stellar8004.com) → agent **10** ("Scrapper") | Same agent the tools return, live on mainnet |

Anything deeper — installing the server, running the demo — is covered below.

---

## 1. Deliverable 1 — open-source MCP server (4 tools)

> *An open-source MCP server (TypeScript, MIT) exposing the stellar-8004 on-chain registry to any MCP client:
> `find_agent`, `rank_agent`, `get_agent_profile`, `list_services`.*

| Evidence required by SOW | Status | Link |
|---|---|---|
| Public GitHub repository | ✅ | [github.com/berkingurcan/stellar-agent-search](https://github.com/berkingurcan/stellar-agent-search) — public, default branch `main`, verified from a logged-out session |
| npm package | ✅ | [npmjs.com/package/stellar-agent-search](https://www.npmjs.com/package/stellar-agent-search) — `0.1.0`, OIDC Trusted Publishing with a Sigstore provenance badge resolving to this repository and tag `v0.1.0` |
| Screen recording of the 4 tools in Claude Code | ⬜ | `‹recording link›` |
| Tool reference docs | ✅ | [docs/tools.md](tools.md) |

### What was delivered against the promise

The SOW committed to **four** tools. The server ships **thirteen** read-only tools; the four SOW tools are the
core, the other nine are supporting reads over the same registry.

| SOW tool | Status | What it does |
|---|---|---|
| `find_agent` | ✅ | Natural-language query → ranked candidates |
| `rank_agent` | ✅ | 3-axis reputation ranking + payment method + endpoint, with per-axis breakdown |
| `get_agent_profile` | ✅ | Full metadata: identity, services, scores, recent feedback |
| `list_services` | ✅ | Catalog of self-declared x402 / MPP endpoint candidates; no liveness, ownership, conformance, or payment proof |

Additional: `list_agents`, `leaderboard`, `resolve_agent`, `get_agents_by_owner`, `get_agent_feedback`,
`verify_reputation`, `get_agent_card`, `get_registry_stats`, `get_registry_health`. Plus 8 MCP **resources**
(`stellar8004://…`) and 5 **prompts** (slash-command workflows), neither of which the SOW required.

### Beyond scope: fail closed instead of promoting a plausible subset

The SOW asked for ranking by reputation. The ranking inputs remain explicitly Explorer-declared. This server
also performs one bounded `get_clients_paginated(agent_id, 0, 6)` simulation with **no funded account and no
private key**, but uses it only to test contract-path reachability. The compacted result cannot prove client-set
exhaustion: an expired slot can be skipped while a later retained client still exists. Supplying that unproven
set to `get_summary` could create a plausible but false match or mismatch, so production code does not call
`get_summary` and verifies no reputation field. A reachable attempt returns `unavailable` with
`reason: client-set-exhaustion-unprovable`, `verifiedFields: []`, and every reputation field unverified.

For historical debugging only, a **manual bounded-subset observation** was recorded against agent 10 on
2026-07-28. It is not MCP/CLI verification, is not consumed by ranking, and must not be used as a trust or
payment gate:

| Manual source | Average score | Feedback count | Unique clients |
|---|---:|---:|---|
| Explorer snapshot (declared) | 96.75 | 8 | 4 |
| `get_summary` supplied with the 4 addresses observed in one requested window | 96 | 8 | not derivable |
| Product verdict | **no comparison** | `unavailable` | `verifiedFields: []`; client-set exhaustion unprovable |

The manual observation can be reproduced without this code by simulating two calls against the Reputation
contract `CBOIAIMMWAXI57OATLX6BWVDQLCC4YU55HV6MZXFRP6CBSGAMXSTEPPA` on
`https://mainnet.sorobanrpc.com`: `get_clients_paginated(agent_id: 10, start: 0, limit: 20)` returned four
addresses in that requested window, and a separate manual `get_summary` supplied with exactly those addresses
returned `summary_value 96`, `summary_value_decimals 0`, and `count 8`. Both calls are read-only simulations,
but the second result describes only its caller-supplied subset. It does not prove that the subset is complete,
that it shares a snapshot with the Explorer, or that the reviewers are Sybil-resistant.

> **Note for anyone running behind an HTTP proxy.** The contract reachability read deliberately uses Stellar SDK
> v16's fetch-based default contract transport, so the historical axios/proxy `405` failure is not an accepted explanation
> anymore. If `doctor` reports `✗ contract read path FAILED`, treat the RPC/simulation path as unhealthy and
> investigate it. Tool calls still degrade to `unavailable` rather than guessing.

### How to verify yourself

```bash
npx -y stellar-agent-search@0.1.0 doctor              # self-check: environment, explorer, RPC, contract reachability
npx -y stellar-agent-search@0.1.0 find "web scraper"  # the find_agent tool from the terminal
npx -y stellar-agent-search@0.1.0 profile 10          # declared profile + fail-closed evidence block
```

Inside an MCP client, install with one line and call the tools directly:

```bash
npx -y stellar-agent-search@0.1.0 setup --client claude --scope user --handshake
```

---

## 2. Deliverable 2 — x402 reference script + mainnet run

> *A reference script in `/examples` that uses the MCP server to find the scrapper agent, pays it via x402
> (USDC) on Stellar mainnet, receives the result, and writes feedback to the Reputation Registry. Captured on
> video with mainnet transaction hashes.*

| Evidence required by SOW | Status | Link |
|---|---|---|
| Reference script in the repo | ✅ | [examples/x402-demo.ts](../examples/x402-demo.ts) |
| Demo video (3–5 min) | 🟡 | `‹video link — recorded, awaiting upload›` |
| Mainnet tx hash — x402 USDC payment | ✅ | [de0717ec…be3c55](https://stellar.expert/explorer/public/tx/de0717ecb5b34b712fd196c8438cb20bff52e4f843fc7b8263e03b1dd5be3c55) |
| Mainnet tx hash — Reputation Registry feedback | ✅ | [10d73971…740846](https://stellar.expert/explorer/public/tx/10d739713a02ae517bc96b8507d0d6ae28913ccdd7b10484f77e37bf8c740846) |

The recorded funded run executed on 2026-07-30T08:05Z: payment settled in ledger 63715338, the paid scrape
result validated (`resultOk: true`), and feedback landed in ledger 63715340 — both hashes are Horizon-verified
(`successful: true`) live inside the recording. Earlier funded runs provide additional on-chain evidence:
a complete loop at 07:05Z
([payment 59a5fb60…](https://stellar.expert/explorer/public/tx/59a5fb60b43bca68ee6383b66acc551b3e7a6ab1f8d42c08fca2a8cc1919e640),
[feedback 87520294…](https://stellar.expert/explorer/public/tx/875202943e10dd337c4b91e64cfc99afa034f2ec27fd4aceda7c6bf4e2c6dbed)),
a second complete loop at 07:53Z
([payment bd80a28c…](https://stellar.expert/explorer/public/tx/bd80a28ccaa7ded4a1043c2575d6131514d5d75d8cacd5decddb356a59f0b350),
[feedback 3f3837b1…](https://stellar.expert/explorer/public/tx/3f3837b159641633b266dc22c6dfafdc3bc24c31c7f1c42ff0d847a8bb050653)),
and a settled payment at 06:12Z
([bd8ab74d…](https://stellar.expert/explorer/public/tx/bd8ab74d117067498b6174b569e563e7812b7ea98a7d212dea7f8214aa5c5e55))
whose run aborted before feedback because the client rejected soroban-rpc's int64-string `createdAt`;
that bug is fixed and regression-tested (commit `c002c79`).

### What the script does, in order

1. **Discover** — calls the MCP server's discovery path to find the Scrapper agent (id 10) by capability.
2. **Constrain** — records that current reputation evidence is unavailable and cannot authorize payment;
   separately requires the reviewed/pinned identity, endpoint, owner, payee, network, asset, and budget policy.
3. **Call** — requests the agent's endpoint; receives HTTP **402 Payment Required** with a payment challenge.
4. **Pay** — checks the untrusted challenge against a reviewed exact tuple, signs once, never auto-retries,
   then independently verifies finality and the exact USDC transfer through Stellar RPC.
5. **Receive** — gets the scraping result back.
6. **Report** — writes reputation feedback on-chain via `give_feedback`, scored on whether the result actually
   succeeded.

Both on-chain steps (4 and 6) emit transaction hashes, which the script records to
`examples/run-<timestamp>.json`.

### Security note

This script is the **only** keyed code in the repository. The MCP server itself holds no private keys and signs
nothing — that separation is enforced by an automated test (`test/readonly-invariant.test.ts`), so the boundary
cannot silently erode.

---

## 3. Deliverable 3 — one-command install + developer docs

> *One-command install for any developer: `npx skills add trionlabs/stellar-8004 --skill mcp` **(or equivalent)**
> brings the MCP into Claude Code, Cursor, or any MCP-compatible client. Developer docs: README, getting-started
> guide, MCP tool reference, integration guide, contribution notes.*

| Evidence required by SOW | Status | Link |
|---|---|---|
| Skill package install command | ✅ | [`skills/mcp/SKILL.md`](../skills/mcp/SKILL.md) — `npx skills add berkingurcan/stellar-agent-search --skill mcp` resolves against the public default branch |
| One-command MCP bootstrap | 🟡 | [`src/cli/setup.ts`](../src/cli/setup.ts) + [`test/setup.test.ts`](../test/setup.test.ts) — published `0.1.0` verified end-to-end (`setup --client cursor --scope project --handshake` → 13 tools, idempotent `--check` pass) in an isolated directory; the on-camera clean-environment proof is Recording 3 |
| Developer docs URL | ✅ | [Repository docs](https://github.com/berkingurcan/stellar-agent-search#readme) — publicly accessible |
| Install + usage screen recording | ⬜ | `‹recording link›` |

### One-command MCP bootstrap and optional skill acquisition

The runtime installer is the idempotent `setup` command. It registers an explicit stdio launch, refuses to
overwrite a conflicting entry, and can prove the package works with a live MCP handshake:

```bash
# Claude Code, user scope
npx -y stellar-agent-search@0.1.0 setup --client claude --scope user --handshake

# Cursor, project scope; use this in Recording 3 as the required second client
npx -y stellar-agent-search@0.1.0 setup --client cursor --scope project --handshake

# Codex, user scope
npx -y stellar-agent-search@0.1.0 setup --client codex --scope user --handshake

# Non-mutating verification or preview
npx -y stellar-agent-search@0.1.0 setup --client cursor --scope project --check --handshake
npx -y stellar-agent-search@0.1.0 setup --client cursor --scope project --dry-run --json
```

Codex `project` scope is deliberately not auto-written: its CLI has no project-scoped MCP add operation.
`setup --client codex --scope project` makes no change, exits non-zero, and emits the exact TOML block to merge
into `.codex/config.toml`. This limitation must not be presented as an automated install.

The optional skill is the usage guide an agent reads before calling the server:

```bash
npx skills add berkingurcan/stellar-agent-search --skill mcp
```

The SOW's example command names the `trionlabs/stellar-8004` repository and allows *"or equivalent"*. We serve
the skill from **this** repository instead: the server is an independent MIT package with its own release
cadence, so the skill belongs beside the code it installs — one source of truth, versioned with the server, and
no cross-repository merge in the release path. `skills/mcp/SKILL.md` sits next to `src/`, so a change to the
tool surface and its documentation land in the same commit — and
[`test/skill-sync.test.ts`](../test/skill-sync.test.ts) fails CI if the skill's tool/resource/prompt counts or
its version pin drift from the code, so the coupling is enforced rather than merely intended.

The skill documents MCP registration for **eight** clients and carries a copy-paste config for each. That is
configuration coverage, not proof that all eight clients were integration-tested. Automated setup covers
Claude Code and Cursor at user/project scope, plus Codex at user scope. The still-unrecorded SOW acceptance run
will exercise Claude Code and Cursor in clean environments.

### Documentation checklist

| SOW-named doc | Status | File |
|---|---|---|
| README | ✅ | [README.md](../README.md) |
| Getting-started guide | ✅ | [docs/getting-started.md](getting-started.md) |
| MCP tool reference | ✅ | [docs/tools.md](tools.md) |
| Integration guide | ✅ | [docs/integration.md](integration.md) — 8 clients |
| Contribution notes | ✅ | [CONTRIBUTING.md](../CONTRIBUTING.md) |

Also present, beyond the SOW list: [docs/architecture.md](architecture.md), [SECURITY.md](../SECURITY.md),
[CHANGELOG.md](../CHANGELOG.md).

### Client coverage

The SOW asks for Claude Code and one other client. **Claude Code, Cursor, Windsurf, Cline, VS Code, Claude
Desktop, Codex CLI, and Gemini CLI** are documented. That is not yet acceptance evidence: Recording 1 must
exercise Claude Code, and Recording 3 must exercise Cursor. Both links remain ⬜ until those recordings exist.

---

## 4. Also delivered (budget line items)

| Line item from the budget rationale | Status | Evidence |
|---|---|---|
| Multi-client integration testing | 🟡 | [docs/integration.md](integration.md) contains per-client config and caveats; real clean-environment evidence for Claude Code + one additional client is still required |
| CI/CD setup | ✅ | [.github/workflows/ci.yml](../.github/workflows/ci.yml) — Node 22/24 × Linux/macOS; typecheck, build, test, pack; separate Worker typecheck/test/bundle audit |
| Remote Streamable HTTP Worker | 🟡 | [`worker/`](../worker/) — implemented behind exact `/mcp` and `/healthz` Cloudflare routes, but deliberately not claimed live until namespace configuration and production canary pass |
| npm publishing setup | ✅ | [.github/workflows/publish.yml](../.github/workflows/publish.yml) — tag-triggered, OIDC Trusted Publishing with Sigstore provenance, plus MCP Registry publish |
| Skill packaging + distribution | ✅ | [`skills/mcp/SKILL.md`](../skills/mcp/SKILL.md) — ships in the repository, where `npx skills add` fetches it; deliberately kept out of the npm tarball (`files` in [package.json](../package.json)) so the published package stays lean |
| Mainnet gas | ⬜ | Consumed by the Deliverable 2 run |
| Demo video production | ⬜ | See recordings below |

Registry manifests are in place for three directories: [`server.json`](../server.json) (official MCP Registry),
[`smithery.yaml`](../smithery.yaml), [`glama.json`](../glama.json).

**Quality signals not required by the SOW:** a full automated suite green on every push across Node 22/24 ×
Linux/macOS (count and result in the [Actions tab](https://github.com/berkingurcan/stellar-agent-search/actions) —
deliberately not restated here, so it cannot go stale), clean TypeScript typecheck, and automated/internal
adversarial review passes. The repository has **not** had an independent external human code review; the
remaining consumer dependency finding is tracked explicitly under [`issues/`](../issues/README.md).

---

## 5. Explicitly out of scope

Per SOW §4.1, none of the following are part of this Instaward and none are claimed here: consumer chat product,
backend message relayer, new Soroban contracts, additional first-party agents, explorer UI redesign.

The **Validation** registry is likewise not in scope — the SOW names Identity and Reputation usage only. The
server reads Identity and Reputation, and reports Validation indexer health. A full Validation axis is planned
for the follow-on SCF scope.

---

## 6. Outstanding items and their order

These are the items that block **delivery**. Full detail — verification steps and acceptance criteria — lives
in one file per item under [`issues/`](../issues/); this table is the state, not a second copy of it.

| # | Item | State |
|---|---|---|
| [01](../issues/P0-01-make-repository-public.md) | Canonical repository public under `berkingurcan` | ✅ done — verified logged-out |
| [02](../issues/P0-02-set-default-branch-to-main.md) | Default branch is `main` | ✅ done |
| [03](../issues/P0-03-first-npm-publish.md) | Inert bootstrap reservation, then protected OIDC real release | ✅ done — npm `0.1.0` live with provenance; MCP Registry `0.1.0` live and verified against `server.json` |
| [04](../issues/P0-04-funded-mainnet-x402-run.md) | Funded mainnet run of `examples/x402-demo.ts` | 🟡 payer funded (XLM + USDC trustline), preflight green, live challenge validates; awaiting the recorded run |
| [05](../issues/P0-05-record-three-demos.md) | Recordings 1–3 | ⬜ the last SOW-blocking step |

[docs/recordings.md](recordings.md) has the shot-by-shot scripts.

Known engineering work that does **not** block SOW delivery — including one defect that reaches users of the
published package — is tracked in the same place: see [`issues/README.md`](../issues/README.md). It is listed
openly rather than omitted, on the same principle as the declared-vs-bounded-evidence reporting this server is
built around.

---

## Recording index

| # | Deliverable | Length | Script |
|---|---|---|---|
| 1 | D1 — four tools in Claude Code | 2–3 min | [docs/recordings.md](recordings.md#recording-1) |
| 2 | D2 — x402 mainnet demo | 3–5 min | [docs/recordings.md](recordings.md#recording-2) |
| 3 | D3 — clean-environment install | 1–2 min | [docs/recordings.md](recordings.md#recording-3) |

<a id="recording-2--x402-mainnet-demo-35-min"></a>
