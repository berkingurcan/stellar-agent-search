# Evidence package — Instawards SOW

**Project:** Stellar Agent MCP (Stellar 8004 agent discovery)
**Builder / Team:** Algoria Team
**Ambassador Chapter:** Stellar Türkiye

This page maps each SOW deliverable to its evidence and gives a step-by-step way to verify it. It is written for
a reviewer **without** a technical background: everything in [§0](#0-five-minute-verification-no-install) can be
checked in a browser in about five minutes.

**Status legend:** ✅ shipped and verifiable · 🟡 built, awaiting a mainnet run or recording · ⬜ not yet produced

> Items marked `‹fill in›` are links that only exist after a publish or recording step. They are listed here so
> the reviewer can see exactly what is outstanding rather than having to infer it.

> [!IMPORTANT]
> **The repository is currently private.** Every link on this page returns 404 to anyone who is not a
> collaborator, and the SOW requires a *public* MIT repository. Flip it before sending this to a reviewer:
> **Settings → General → Danger Zone → Change visibility → Make public**. This also unblocks npm provenance and
> the MCP Registry publish, both of which require a public repository.

---

## 0. Five-minute verification (no install)

| # | What to check | Where | Expected |
|---|---|---|---|
| 1 | The code is public and MIT-licensed | [github.com/berkingurcan/stellar-agent-mcp](https://github.com/berkingurcan/stellar-agent-mcp) | Repository opens; `LICENSE` says MIT |
| 2 | Automated tests pass | Repo → **Actions** tab | Latest CI run green across Node 18/20/22 on Linux + macOS |
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
| Public GitHub repository | 🟡 | [github.com/berkingurcan/stellar-agent-mcp](https://github.com/berkingurcan/stellar-agent-mcp) — code complete and MIT-licensed, but **visibility is still private**; see the note at the top |
| npm package | ⬜ | `‹npmjs.com/package/stellar-agent-mcp — after publish›` |
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
| `list_services` | ✅ | Catalog of x402 / MPP-enabled agent endpoints |

Additional: `list_agents`, `leaderboard`, `resolve_agent`, `get_agents_by_owner`, `get_agent_feedback`,
`verify_reputation`, `get_agent_card`, `get_registry_stats`, `get_registry_health`. Plus 8 MCP **resources**
(`stellar8004://…`) and 5 **prompts** (slash-command workflows), neither of which the SOW required.

### Beyond scope: reputation is verified, not reported

The SOW asked for ranking by reputation. Reputation numbers on any registry are normally taken from an indexer
— that is, taken on faith. This server instead re-derives each agent's reputation **directly from the Reputation
smart contract** (`get_summary` + `get_clients_paginated`) and reports a declared-vs-verified diff. It works on
default mainnet with **no funded account and no private key**.

Reviewer check, on agent 10 (confirmed against mainnet on 2026-07-28):

| Source | Average score | Feedback count | Unique clients |
|---|---|---|---|
| Explorer (declared) | 96.75 | 8 | 4 |
| Reputation contract (verified) | 96 | 8 | 4 |
| Result | **`verified`** | | |

This is independently reproducible without our code. Simulate two read calls against the Reputation contract
`CBOIAIMMWAXI57OATLX6BWVDQLCC4YU55HV6MZXFRP6CBSGAMXSTEPPA` on `https://mainnet.sorobanrpc.com`:

- `get_clients_paginated(agent_id: 10, start: 0, limit: 20)` → 4 addresses, beginning
  `GAAIBWG3M3U6PAS3IC5BATPT52XKNYXBRJXQIPHEDQUQIEFQDYH4KZY7`
- `get_summary(agent_id: 10, client_addresses: <those 4>, tag1: "", tag2: "")` →
  `summary_value 96`, `summary_value_decimals 0`, `count 8`

Both are read-only simulations: no account, no funds, no signature.

> **Note for anyone running behind an HTTP proxy.** The Stellar SDK's RPC transport uses axios, and versions
> below 1.16.1 send a plain-HTTP request that some proxies reject with `405`. If `doctor` reports
> `✗ verify  on-chain read FAILED (rpc-error)`, that is the environment, not the registry — the explorer and
> RPC health checks above it will still pass. Everything else keeps working; verification reports `unavailable`
> rather than guessing.

### How to verify yourself

```bash
npx -y stellar-agent-mcp doctor              # self-check: environment, explorer, RPC, on-chain verification
npx -y stellar-agent-mcp find "web scraper"  # the find_agent tool from the terminal
npx -y stellar-agent-mcp profile 10          # full profile incl. declared-vs-verified block
```

Inside an MCP client, install with one line and call the tools directly:

```bash
claude mcp add --scope user stellar-agent -- npx -y stellar-agent-mcp
```

---

## 2. Deliverable 2 — x402 reference script + mainnet run

> *A reference script in `/examples` that uses the MCP server to find the scrapper agent, pays it via x402
> (USDC) on Stellar mainnet, receives the result, and writes feedback to the Reputation Registry. Captured on
> video with mainnet transaction hashes.*

| Evidence required by SOW | Status | Link |
|---|---|---|
| Reference script in the repo | ✅ | [examples/x402-demo.ts](../examples/x402-demo.ts) |
| Demo video (3–5 min) | ⬜ | `‹video link›` |
| Mainnet tx hash — x402 USDC payment | ⬜ | `‹stellar.expert link›` |
| Mainnet tx hash — Reputation Registry feedback | ⬜ | `‹stellar.expert link›` |

The script is written and dry-run tested; what remains is one funded mainnet execution, which produces both
hashes and the footage in a single pass. See [Recording 2](#recording-2--x402-mainnet-demo-35-min) for the exact
run procedure.

### What the script does, in order

1. **Discover** — calls the MCP server's discovery path to find the Scrapper agent (id 10) by capability.
2. **Vet** — verifies its reputation against the Reputation contract before spending anything.
3. **Call** — requests the agent's endpoint; receives HTTP **402 Payment Required** with a payment challenge.
4. **Pay** — signs a USDC payment over x402 against the `payTo` address from the challenge, and retries.
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
| Skill package install command | 🟡 | [`skills/mcp/SKILL.md`](../skills/mcp/SKILL.md) — served from this repository; **the command resolves only once the repo is public and `main` is the default branch** (outstanding items 0 and 2) |
| Developer docs URL | ✅ | [Repository docs](https://github.com/berkingurcan/stellar-agent-mcp#readme) |
| Install + usage screen recording | ⬜ | `‹recording link›` |

### The one-command install

```bash
npx skills add berkingurcan/stellar-agent-mcp --skill mcp
```

The SOW's example command names the `trionlabs/stellar-8004` repository and allows *"or equivalent"*. We serve
the skill from **this** repository instead: the server is an independent MIT package with its own release
cadence, so the skill belongs beside the code it installs — one source of truth, versioned with the server, and
no cross-repository merge in the release path. `skills/mcp/SKILL.md` sits next to `src/`, so a change to the
tool surface and its documentation land in the same commit — and
[`test/skill-sync.test.ts`](../test/skill-sync.test.ts) fails CI if the skill's tool/resource/prompt counts or
its version pin drift from the code, so the coupling is enforced rather than merely intended.

The skill documents MCP registration for **eight** clients and carries a copy-paste config for each.

Then register the server:

```bash
claude mcp add --scope user stellar-agent -- npx -y stellar-agent-mcp
```

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

The SOW asked for Claude Code and one other client. Documented and configured: **Claude Code, Cursor, Windsurf,
Cline, VS Code, Claude Desktop, Codex CLI, Gemini CLI**.

---

## 4. Also delivered (budget line items)

| Line item from the budget rationale | Status | Evidence |
|---|---|---|
| Multi-client integration testing | ✅ | [docs/integration.md](integration.md) — per-client config and caveats |
| CI/CD setup | ✅ | [.github/workflows/ci.yml](../.github/workflows/ci.yml) — Node 18/20/22 × Linux/macOS; typecheck, build, test, pack |
| npm publishing setup | ✅ | [.github/workflows/publish.yml](../.github/workflows/publish.yml) — tag-triggered, OIDC Trusted Publishing with Sigstore provenance, plus MCP Registry publish |
| Skill packaging + distribution | ✅ | [`skills/mcp/SKILL.md`](../skills/mcp/SKILL.md) — ships in the repository, where `npx skills add` fetches it; deliberately kept out of the npm tarball (`files` in [package.json](../package.json)) so the published package stays lean |
| Mainnet gas | ⬜ | Consumed by the Deliverable 2 run |
| Demo video production | ⬜ | See recordings below |

Registry manifests are in place for three directories: [`server.json`](../server.json) (official MCP Registry),
[`smithery.yaml`](../smithery.yaml), [`glama.json`](../glama.json).

**Quality signals not required by the SOW:** 106 automated tests, clean TypeScript typecheck, two independent
adversarial code-review passes plus a security review with all findings resolved.

---

## 5. Explicitly out of scope

Per SOW §4.1, none of the following are part of this Instaward and none are claimed here: consumer chat product,
backend message relayer, new Soroban contracts, additional first-party agents, explorer UI redesign.

The **Validation** registry is likewise not in scope — the SOW names Identity and Reputation usage only. The
server reads Identity and Reputation, and reports Validation indexer health. A full Validation axis is planned
for the follow-on SCF scope.

---

## 6. Outstanding items and their order

Everything below requires credentials or funds that only the builder holds.

| # | Item | Unblocks | Owner |
|---|---|---|---|
| 0 | **Make the repository public** (Settings → General → Danger Zone) | Everything reviewer-facing; the SOW requires a public MIT repo. Also required for npm provenance and the MCP Registry publish | Builder |
| 1 | `npm publish` (or push a `v0.1.0` tag once Trusted Publishing is configured) | D1 npm link; makes `npx -y stellar-agent-mcp` resolve, which Recordings 1 and 3 depend on | Builder |
| 2 | Set the GitHub **default branch to `main`** (Settings → General → Default branch) | D3 install command — `npx skills add` reads the default branch, which is currently the disposable working branch; also makes CI run on the branch reviewers see | Builder |
| 3 | Funded mainnet run of `examples/x402-demo.ts` | D2 both tx hashes | Builder |
| 4 | Recordings 1–3 | D1, D2, D3 recordings | Builder |

Item 0 blocks review entirely; items 0 and 2 together gate the one-command install; item 1 gates the two
install recordings. See
[docs/recordings.md](recordings.md) for shot-by-shot scripts.

---

## Recording index

| # | Deliverable | Length | Script |
|---|---|---|---|
| 1 | D1 — four tools in Claude Code | 2–3 min | [docs/recordings.md](recordings.md#recording-1) |
| 2 | D2 — x402 mainnet demo | 3–5 min | [docs/recordings.md](recordings.md#recording-2) |
| 3 | D3 — clean-environment install | 1–2 min | [docs/recordings.md](recordings.md#recording-3) |

<a id="recording-2--x402-mainnet-demo-35-min"></a>
