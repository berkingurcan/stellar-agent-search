# Recording scripts — SOW evidence footage

Three recordings are required by the SOW. This page is a shot-by-shot script for each: what to run, what must be
visible on screen, and what a reviewer needs to hear.

**General rules for all three**

- Record at **1080p or higher**, terminal font large enough to read on a phone (16pt+).
- **Never show a private key.** Open `examples/.env` at no point. If a key could appear in scrollback, use a
  fresh terminal.
- Do not cut mid-command. A reviewer's trust comes from seeing an uninterrupted run.
- Say the numbers out loud as they appear — an Ambassador reviewer is not reading JSON.
- Upload unlisted to YouTube or Loom and paste the links into [docs/evidence.md](evidence.md).

**Prerequisites for Recordings 1 and 3** — both are checked from a machine with no credentials, so both must be
true before you hit record:

1. **`stellar-agent-mcp` is published to npm**, otherwise `npx -y stellar-agent-mcp` fails.
2. **The repository is public and its default branch is `main`.** `npx skills add` fetches `skills/mcp/SKILL.md`
   over GitHub from the *default branch* — a private repo or a default branch still pointing at a working branch
   makes step 2 of Recording 3 fail on camera.

Verify both from a logged-out shell first:

```bash
npm view stellar-agent-mcp version                                   # must print a version
curl -sI https://raw.githubusercontent.com/berkingurcan/stellar-agent-mcp/main/skills/mcp/SKILL.md | head -1
                                                                     # must be 200, not 404
```

---

<a id="recording-1"></a>

## Recording 1 — the four tools in Claude Code

**Deliverable 1** · target length **2–3 minutes** · no funds required

Proves the four SOW tools work inside a real MCP client against live mainnet data.

### Setup (before recording)

```bash
claude mcp add --scope user stellar-agent -- npx -y stellar-agent-mcp
```

Restart Claude Code. Confirm the server is connected before you hit record.

### Shot list

| # | Action | What must be on screen | Say |
|---|---|---|---|
| 1 | Run `/mcp` | The `stellar-agent` server listed as connected, with its tools | "The server is installed and connected. Thirteen read-only tools; the four core ones are what this deliverable covers." |
| 2 | Ask: *"Use find_agent to find a paid web scraper with a good reputation"* | The `find_agent` tool call and its ranked result | "**find_agent** — a plain-English query becomes a ranked list of live mainnet agents." |
| 3 | Ask: *"Now rank_agent on agent 10 with verification on"* | The `rank_agent` call showing the 3-axis breakdown and the `verification` block | "**rank_agent** — quality, volume, and breadth. And this block is the important part: the score was re-derived from the Reputation contract, not taken from the indexer. Declared 96.75, verified 96, status **verified**." |
| 4 | Ask: *"Show me the full profile for agent 10"* | The `get_agent_profile` result — identity, services, feedback | "**get_agent_profile** — identity, service endpoints, recent feedback, and the canonical `stellar:…#10` handle that the payment step pays against." |
| 5 | Ask: *"List the services I can actually pay for over x402"* | The `list_services` result | "**list_services** — the catalog of invokable paid endpoints. This is the menu the x402 demo picks from." |
| 6 | Open [stellar8004.com](https://stellar8004.com), find agent 10 | The explorer page next to the terminal result | "Same agent, same numbers, live on mainnet. Nothing here is mocked." |

### If something goes wrong

- Tools missing → fully restart the client; the server is spawned at startup.
- Empty results → check `STELLAR_NETWORK`; the default is mainnet.

---

<a id="recording-2"></a>

## Recording 2 — x402 mainnet demo

**Deliverable 2** · target length **3–5 minutes** · **spends real USDC**

This is the highest-value piece of evidence in the whole package: the full agent-finds-agent loop, on mainnet, in
one take.

### Prerequisites — complete all of these *before* recording

1. A payer keypair (S-format), **separate from the Scrapper agent's owner** — paying yourself reverts with
   `SelfFeedback`.
2. Funded with **~3–5 XLM** (base reserve, trustline reserve, and the self-paid `give_feedback` fee).
3. **USDC trustline added.** Without it USDC transfers fail *silently* — this is the single most common failure.
4. A small USDC balance, **0.5–1 USDC** is plenty (the scrapper charges about \$0.01).
5. `X402_API_KEY` set for the facilitator.
6. `npm run build` has been run at the repo root, so `dist/index.js` exists.

### Rehearsal — do this off-camera, twice

```bash
# 1. testnet dry run — exercises the wiring, NOT a testnet rehearsal (see note)
STELLAR_NETWORK=testnet DRY_RUN=1 npx tsx examples/x402-demo.ts

# 2. mainnet dry run — preflight + discovery only, no spend
DRY_RUN=1 npx tsx examples/x402-demo.ts
```

Both must reach discovery cleanly and report the preflight balances you expect. Only then record.

> **What the testnet run does and does not prove.** The default explorer indexes **mainnet only**, so run 1
> discovers *mainnet* agents while pointing the Soroban reads at testnet — the server prints a warning saying
> exactly that. It is a useful smoke test of the script's wiring, but it is not a testnet rehearsal of a real
> payment. The demo will refuse to pay across that seam: it compares the 402 challenge's network against the
> configured CAIP-2 id and aborts on `network mismatch`. Run 2 is the one that rehearses the real thing.

### Shot list

| # | Action | What must be on screen | Say |
|---|---|---|---|
| 1 | Show `examples/x402-demo.ts` briefly, then the security note in `examples/README.md` | The env-allowlist paragraph | "The MCP server is read-only and holds no keys. All signing happens only in this demo script — and the server subprocess is spawned with an allowlist that never contains the private key." |
| 2 | Run the mainnet dry-run | Preflight output: trustline present, USDC and XLM balances | "Preflight — trustline present, funded, RPC healthy. No spend yet." |
| 3 | Run the real thing: `npx tsx examples/x402-demo.ts \| tee examples/run-$(date +%Y%m%d).log` | Whole run, uninterrupted | — |
| 4 | Discovery phase | `find_agent` → `get_agent_profile` output | "The script is using our own MCP server to discover the agent. No hardcoded address." |
| 5 | The 402 | The HTTP 402 challenge | "The agent's endpoint answers **402 Payment Required** with a payment challenge. The `payTo` address comes from this challenge, not from the registry." |
| 6 | Payment settles | The payment tx hash | "USDC paid over x402. That's the first mainnet transaction hash." |
| 7 | Result returned | The scraping result | "And the agent delivered the work." |
| 8 | Feedback write | The feedback tx hash | "Now the script writes reputation feedback back on-chain — so the *next* agent's discovery query sees an updated, verifiable score. Second transaction hash." |
| 9 | Open both hashes on [stellar.expert](https://stellar.expert) | Both transactions confirmed | "Both verifiable on Stellar Expert. Loop closed: discover, pay, receive, rate." |
| 10 | Show `examples/run-<timestamp>.json` | The evidence record | "The run writes a receipt — no secrets in it, just the hashes, the endpoint, and the price." |

### Immediately after recording

Copy both hashes into [docs/evidence.md](evidence.md) §2 as
`https://stellar.expert/explorer/public/tx/<hash>`.

### If something goes wrong mid-take

Stop and restart the recording rather than editing. If the payment succeeded but `give_feedback` failed, the
usual cause is XLM too low for the self-paid fee — top up and re-run; a second payment is cheap.

---

<a id="recording-3"></a>

## Recording 3 — clean-environment install

**Deliverable 3** · target length **1–2 minutes** · no funds required

Proves the one-command install works from nothing. Record on a **fresh machine, container, or new user account** —
the point is that nothing is pre-cached.

### Shot list

| # | Action | What must be on screen | Say |
|---|---|---|---|
| 1 | Show a clean environment: `node -v`, and that no MCP server is configured | Node ≥ 18, empty MCP list | "Fresh environment, nothing cached, no wallet and no API key. Node 18 or newer is all you need installed." |
| 2 | `npx skills add berkingurcan/stellar-agent-mcp --skill mcp` | The skill installing | "One command pulls the skill straight from the project repository." |
| 3 | `claude mcp add --scope user stellar-agent -- npx -y stellar-agent-mcp` | The server registering | "One more line registers the MCP server. No API key, no wallet, no config file to edit." |
| 4 | Restart the client, run `/mcp` | `stellar-agent` connected | "Connected." |
| 5 | Call `find_agent({ "query": "web scraper" })` | Live ranked results | "And from a standing start, we're querying the on-chain registry. Under two minutes." |
| 6 | Optionally `npx -y stellar-agent-mcp doctor` | All checks green | "The built-in self-check confirms the explorer, the RPC, and on-chain verification are all reachable." |

### Note

`npx skills add` copies the skill's documentation; the MCP registration is step 3. Say this plainly on camera so
a reviewer does not think step 2 alone should have produced tools — the skill file itself explains the same
thing.

---

## After all three are recorded

1. Paste the three links into [docs/evidence.md](evidence.md) (§1, §2, §3) and replace the `‹…›` placeholders.
2. Paste the two transaction hashes into §2.
3. Update the status markers from ⬜ to ✅.
4. Send `docs/evidence.md` to the Ambassador Chapter Lead — it is written to be reviewed without technical
   background and links out to everything else.
