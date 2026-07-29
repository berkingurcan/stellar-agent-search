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

1. **`stellar-agent-mcp@0.1.0` is published to npm**, otherwise `npx -y stellar-agent-mcp@0.1.0` fails.
2. **The repository is public and its default branch is `main`.** `npx skills add` fetches `skills/mcp/SKILL.md`
   over GitHub from the *default branch* — a private repo or a default branch still pointing at a working branch
   makes step 4 of Recording 3 fail on camera.

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
npx -y stellar-agent-mcp@0.1.0 setup --client claude --scope user --handshake
```

The output must say `added` or `already-configured`, then show a successful handshake with 13 tools. Restart
Claude Code and confirm the server is connected before you hit record.

### Shot list

| # | Action | What must be on screen | Say |
|---|---|---|---|
| 1 | Run `/mcp` | The `stellar-agent` server listed as connected, with its tools | "The server is installed and connected. Thirteen read-only tools; the four core ones are what this deliverable covers." |
| 2 | Ask: *"Use find_agent to find a paid web scraper with a good reputation"* | The `find_agent` tool call and its ranked result | "**find_agent** — a plain-English query becomes a ranked list of live mainnet agents." |
| 3 | Ask: *"Now rank_agent on agent 10 with verification on"* | The `rank_agent` call showing the 3-axis breakdown and the `verification` block | "**rank_agent** — quality, volume, and breadth. The bounded chain read reports 96 versus the indexer's 96.75 and the active count agrees. Status is **partial**, because active unique clients are not contract-derivable and the reads do not share a snapshot." |
| 4 | Ask: *"Show me the full profile for agent 10"* | The `get_agent_profile` result — identity, services, feedback | "**get_agent_profile** — identity, service endpoints, recent feedback, and the canonical `stellar:…#10` handle that the payment step pays against." |
| 5 | Ask: *"List x402 service candidates and show their verification flags"* | The `list_services` result | "**list_services** — self-declared endpoint candidates, not proof of liveness or payment behavior. The separate demo admits one only after an exact challenge-policy check." |
| 6 | Open [stellar8004.com](https://stellar8004.com), find agent 10 | The explorer page next to the terminal result | "Same agent, same numbers, live on mainnet. Nothing here is mocked." |

### If something goes wrong

- Tools missing → fully restart the client; the server is spawned at startup.
- Registration uncertain → rerun `npx -y stellar-agent-mcp@0.1.0 setup --client claude --scope user --check --handshake`.
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
4. A small USDC balance, **0.5–1 USDC** is plenty (the scrapper's live challenge asks \$0.0001 per scrape).
5. `npm run build` has been run at the repo root, so `dist/index.js` exists.

No facilitator credential is required — the client signs locally and the resource server settles. See
[examples/README.md](../examples/README.md).

### Rehearsal — do this off-camera, twice

```bash
# mainnet dry run — preflight + discovery only, no spend
DRY_RUN=1 npx tsx examples/x402-demo.ts
```

It must reach discovery cleanly and report the preflight balances you expect. Only then record.

> **Why there is no testnet rehearsal.** There is no public testnet indexer, so `STELLAR_NETWORK=testnet`
> without an explicit `EXPLORER_BASE_URL` now **fails at startup** rather than serving mainnet registry rows
> next to testnet on-chain reads. Nothing is lost: `DRY_RUN=1` spends nothing, so the mainnet dry run *is* the
> rehearsal, and it exercises the one path the take actually uses. (The demo would have refused to pay across
> the old seam anyway — it compares the 402 challenge's network against the configured CAIP-2 id and aborts on
> `network mismatch`.)

### Shot list

| # | Action | What must be on screen | Say |
|---|---|---|---|
| 1 | Show `examples/x402-demo.ts` briefly, then the security note in `examples/README.md` | The env-allowlist paragraph | "The MCP server is read-only and holds no keys. All signing happens only in this demo script — and the server subprocess is spawned with an allowlist that never contains the private key." |
| 2 | Run the mainnet dry-run | Preflight output: trustline present, USDC and XLM balances | "Preflight — trustline present, funded, RPC healthy. No spend yet." |
| 3 | Run the real thing: `npx tsx examples/x402-demo.ts \| tee examples/run-$(date +%Y%m%d).log` | Whole run, uninterrupted | — |
| 4 | Discovery phase | `find_agent` → `get_agent_profile` output | "The script discovers through our MCP server, then requires the result to match a separately reviewed and pinned identity, endpoint, owner, and payee policy before any signature." |
| 5 | The 402 | The HTTP 402 challenge | "The endpoint answers **402 Payment Required**. This challenge is an untrusted proposal; its full tuple must match reviewed policy before signing." |
| 6 | Payment settles | The payment tx hash | "USDC paid over x402. That's the first mainnet transaction hash." |
| 7 | Result returned | The scraping result | "And the agent delivered the work." |
| 8 | Feedback write | The feedback tx hash | "Now the script writes reputation feedback back on-chain. The indexer can project it, while this MCP labels only the fields its bounded chain read can actually compare. Second transaction hash." |
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

Proves the one-command MCP bootstrap works from nothing. Record on a **fresh machine, container, or new user
account** — the point is that nothing is pre-cached. Use Cursor here so Recording 1 proves Claude Code and this
recording supplies the SOW's required second-client evidence.

### Shot list

| # | Action | What must be on screen | Say |
|---|---|---|---|
| 1 | Show a clean environment: `node -v`, no `.cursor/mcp.json`, and an empty Cursor MCP list | Node ≥ 20, no `stellar-agent` entry | "Fresh environment, nothing cached, no wallet and no API key. Node 20 or newer is all you need installed." |
| 2 | `npx -y stellar-agent-mcp@0.1.0 setup --client cursor --scope project --handshake` | Human output ending in `install · added`, config path, successful handshake, and all 13 tool names | "This one command downloads the package, registers the server without clobbering other Cursor settings, starts it, and lists its tools." |
| 3 | `npx -y stellar-agent-mcp@0.1.0 setup --client cursor --scope project --check --handshake` | Human output ending in `check · already-configured`; the same 13 tools; no config mutation | "The check is read-only and proves setup is idempotent." |
| 4 | `npx skills add berkingurcan/stellar-agent-mcp --skill mcp` | The optional usage guide installing | "This separate command copies the skill guidance. It is documentation for the agent, not the runtime installer." |
| 5 | Restart Cursor and open **Settings → MCP** | `stellar-agent` connected | "Connected in a second real MCP client." |
| 6 | Call `find_agent({ "query": "web scraper" })` | Live ranked results | "And from a standing start, we're querying the on-chain registry." |
| 7 | Optionally `npx -y stellar-agent-mcp@0.1.0 doctor` | All checks green | "The built-in self-check confirms the explorer, RPC, and bounded Reputation-contract read path are reachable." |

### Note

`npx skills add` copies the skill's documentation; the MCP runtime registration is step 2. Say this plainly on
camera so a reviewer does not think the skill command alone should have produced tools. The setup command is the
SOW's one-command equivalent; the skill is optional runtime guidance packaged beside it.

---

## After all three are recorded

1. Paste the three links into [docs/evidence.md](evidence.md) (§1, §2, §3) and replace the `‹…›` placeholders.
2. Paste the two transaction hashes into §2.
3. Update the status markers from ⬜ to ✅.
4. Send `docs/evidence.md` to the Ambassador Chapter Lead — it is written to be reviewed without technical
   background and links out to everything else.
