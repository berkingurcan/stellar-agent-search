<script lang="ts">
	import CtaButton from '$lib/components/CtaButton.svelte';
	import AgentRank from '$lib/components/AgentRank.svelte';
	import HealthCheck from '$lib/components/HealthCheck.svelte';
	import VerdictCard from '$lib/components/VerdictCard.svelte';
	import { reveal } from '$lib/actions/reveal.js';
	import { PACKAGE_PUBLISHED } from '$lib/install.js';
	import { INVARIANTS, PROMPTS, RESOURCES, TOOL_COUNT } from '$lib/surface.js';
	import { CAPTURED_ON } from '$lib/transcripts.js';
	import { EXPLORER, GITHUB, PAPER, SDK_DOCS, SITE } from '$lib/links.js';

	const DESCRIPTION =
		'A read-only MCP server for discovering and ranking x402 payment agents on Stellar mainnet.';
</script>

<svelte:head>
	<title>stellar-agent-mcp — discover and rank Stellar payment agents</title>
	<meta name="description" content={DESCRIPTION} />
	<link rel="canonical" href={SITE} />
	<meta property="og:title" content="stellar-agent-mcp" />
	<meta property="og:description" content={DESCRIPTION} />
	<meta property="og:url" content={SITE} />
	<meta property="og:type" content="website" />
	<meta name="twitter:card" content="summary" />
</svelte:head>

<div>
	<!-- ── Hero ─────────────────────────────────────────────────────── -->
	<section class="space-y-20 pt-8 sm:space-y-24">
		<div class="reveal space-y-10">
			<div class="flex items-center gap-2.5 text-text-dim">
				<svg
					class="h-3.5 w-3.5"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M4 9V5h4" />
					<path d="M16 5h4v4" />
					<path d="M20 15v4h-4" />
					<path d="M8 19H4v-4" />
					<circle cx="12" cy="12" r="1.5" />
				</svg>
				<span class="text-[11px] tracking-[0.2em] uppercase">
					<span
						class="tip"
						role="button"
						tabindex="0"
						data-tooltip="Model Context Protocol — an open standard for exposing tools to AI clients like Claude Code, Cursor, and VS Code. This server is read-only."
						aria-label="MCP — Model Context Protocol, an open standard for exposing tools to AI clients.">MCP</span
					> · Stellar · <span
						class="tip"
						role="button"
						tabindex="0"
						data-tooltip="An HTTP-native micropayment protocol. Agents charge per request in stablecoins like USDC via a challenge-response."
						aria-label="x402 — an HTTP-native micropayment protocol.">x402</span
					> payments
				</span>
			</div>

			<h1
				class="max-w-3xl text-[3rem] leading-[1.02] font-light tracking-[-0.04em] text-text sm:text-[4.75rem]"
			>
				Find the right<br />payment agent.
			</h1>

			<p class="max-w-lg text-[16px] leading-[1.6] text-text-muted">
				Discover, rank, and vet
				<span
					class="tip"
					role="button"
					tabindex="0"
					data-tooltip="A registry of payment agents on Stellar mainnet (stellar8004.com). Agents self-publish their name, capabilities, reputation, and x402 endpoint — none of it is pre-verified."
					aria-label="stellar-8004 — a registry of payment agents on Stellar mainnet.">stellar-8004</span
				>
				agents that accept x402 micropayments.
				<span
					class="tip"
					role="button"
					tabindex="0"
					data-tooltip="Data the agent's owner published about their own agent. Unverified by default — labeled as such, never treated as fact."
					aria-label="Self-declared — data published by the agent's owner; unverified by default.">Self-declared</span
				>
				reputation, checked against the chain.
			</p>
		</div>

		<div class="reveal reveal-d1 max-w-2xl">
			<p class="mb-6 text-[10px] tracking-[0.18em] text-text-dim uppercase">
				Sample probe · mainnet
			</p>
			<VerdictCard />
		</div>

		<div class="reveal reveal-d2 flex flex-col gap-4">
			<div class="flex flex-wrap items-center gap-3">
				<CtaButton href={PACKAGE_PUBLISHED ? '#install' : SDK_DOCS} size="md" external={!PACKAGE_PUBLISHED}>
					{PACKAGE_PUBLISHED ? 'Add to your client' : 'SDK docs'}
					<svg
						class="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						stroke-width="2"
						aria-hidden="true"
					>
						<path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
					</svg>
				</CtaButton>
				<CtaButton href={EXPLORER} variant="secondary" size="md" external>Explore registry</CtaButton>
			</div>

			<p class="text-[11px] text-text-dim">
				{#if !PACKAGE_PUBLISHED}
					Pre-release · install at 0.1.0 ·
					<a
						href={GITHUB}
						target="_blank"
						rel="noopener noreferrer"
						class="underline hover:text-text-muted">watch repo →</a
					>
				{:else}
					Runs in Claude Code · Cursor · Windsurf · Cline · VS Code
				{/if}
			</p>
		</div>
	</section>

	<!-- ── Evidence ─────────────────────────────────────────────────── -->
	<section id="why" class="mt-40 scroll-mt-24 border-t border-border pt-32 space-y-20">
		<div class="space-y-6" use:reveal>
			<span class="text-[11px] tracking-[0.2em] text-text-dim uppercase">
				The trust gap
			</span>
			<h2
				class="max-w-2xl text-[2rem] leading-[1.1] font-light tracking-[-0.03em] text-text sm:text-[2.75rem]"
			>
				59–91% of agent reviewers are
				<span
					class="tip"
					role="button"
					tabindex="0"
					data-tooltip="A Sybil attack: one operator creates many fake identities to inflate reputation. 'Sybil reviewers' aren't distinct humans."
					aria-label="Sybils — reviewers that aren't distinct humans; one operator creating fake identities.">Sybils</span
				>.
			</h2>
			<p class="max-w-xl text-[16px] leading-[1.6] text-text-muted">
				Agent directories list self-declared reputations for payment agents on Stellar. This server
				ranks them — then probes the on-chain
				<span
					class="tip"
					role="button"
					tabindex="0"
					data-tooltip="A Soroban smart contract on Stellar mainnet storing per-agent reputation. This server reads it once to confirm reachability — it doesn't verify every field."
					aria-label="Reputation contract — a Soroban smart contract storing per-agent reputation.">Reputation contract</span
				>
				and tells you exactly what it can verify.
			</p>
		</div>

		<div
			class="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3"
			use:reveal
		>
			<div class="bg-surface p-8 space-y-8">
				<svg
					class="h-5 w-5 text-text-dim"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
					<line x1="12" y1="9" x2="12" y2="13" />
					<line x1="12" y1="17" x2="12.01" y2="17" />
				</svg>
				<div class="space-y-3">
					<p class="text-[3rem] leading-none font-light tabular-nums text-text">
						59<span class="text-text-dim">–91%</span>
					</p>
					<p class="text-[10px] tracking-[0.15em] text-text-dim uppercase">
						Sybil reviewers
					</p>
				</div>
			</div>

			<div class="bg-surface p-8 space-y-8">
				<svg
					class="h-5 w-5 text-text-dim"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M9 17H7A5 5 0 0 1 7 7h2" />
					<path d="M15 7h2a5 5 0 0 1 0 10h-2" />
					<line x1="2" y1="2" x2="22" y2="22" />
				</svg>
				<div class="space-y-3">
					<p class="text-[3rem] leading-none font-light tabular-nums text-text">
						3<span class="text-text-dim">–15%</span>
					</p>
					<p class="text-[10px] tracking-[0.15em] text-text-dim uppercase">
						Live endpoints
					</p>
				</div>
			</div>

			<div class="bg-surface p-8 space-y-8">
				<svg
					class="h-5 w-5 text-text-dim"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
					<line x1="2" y1="2" x2="22" y2="22" />
				</svg>
				<div class="space-y-3">
					<p class="text-[3rem] leading-none font-light tabular-nums text-text">0</p>
					<p class="text-[10px] tracking-[0.15em] text-text-dim uppercase">
						Fields verified
					</p>
				</div>
			</div>
		</div>

		<details class="expand" use:reveal>
			<summary>How ranking and verification work</summary>
			<div class="max-w-2xl space-y-4 text-[14px] leading-[1.7] text-text-muted">
				<p>
					Ranking multiplies Explorer quality by a fixed evidence score — 0.4 volume + 0.6 client
					breadth. It discounts thin claims; it doesn't prove unique humans or Sybil resistance.
				</p>
				<p>
					Verification makes one bounded read to the Reputation contract on
					<span
						class="tip"
						role="button"
						tabindex="0"
						data-tooltip="Stellar's smart-contract platform. The Reputation contract runs on Soroban."
						aria-label="Soroban — Stellar's smart-contract platform.">Soroban</span
					>. A finite client page can't prove the set is exhaustive, so it reports
					<span
						class="tip"
						role="button"
						tabindex="0"
						data-tooltip="The probe confirmed the contract answered. It does not confirm the data is complete or matches declared fields."
						aria-label="reachability — the contract answered; data completeness not confirmed.">reachability</span
					>
					only — status is unavailable, not verified. Source:
					<a
						href={PAPER}
						target="_blank"
						rel="noopener noreferrer"
						class="text-text underline decoration-border underline-offset-4 hover:decoration-accent"
						>arXiv 2606.26028</a
					>.
				</p>
			</div>
		</details>

		<!-- ── Output: designed visualizations, not CLI ── -->
		<div id="output" class="scroll-mt-24 space-y-12" use:reveal>
			<span class="text-[11px] tracking-[0.2em] text-text-dim uppercase">
				Output · captured {CAPTURED_ON}
			</span>

			<AgentRank />

			<HealthCheck />

			<p class="text-[13px] text-text-dim">
				{TOOL_COUNT} tools · {RESOURCES.length} resources · {PROMPTS.length} prompts
				{#if PACKAGE_PUBLISHED}
					—
					<a
						href="{GITHUB}/blob/main/docs/tools.md"
						target="_blank"
						rel="noopener noreferrer"
						class="underline decoration-border underline-offset-4 hover:decoration-accent hover:text-text-muted"
						>docs/tools.md →</a
					>
				{/if}
			</p>
		</div>
	</section>

	<!-- ── Guarantees ───────────────────────────────────────────────── -->
	<section
		id="guarantees"
		use:reveal
		class="mt-40 scroll-mt-24 border-t border-border pt-32 space-y-16"
	>
		<div class="space-y-6">
			<span class="text-[11px] tracking-[0.2em] text-text-dim uppercase">
				Guarantees
			</span>
			<h2
				class="max-w-2xl text-[2rem] leading-[1.1] font-light tracking-[-0.03em] text-text sm:text-[2.75rem]"
			>
				Read-only.
				<span
					class="tip"
					role="button"
					tabindex="0"
					data-tooltip="The server holds no private key and can't sign or submit transactions. It only reads public chain data."
					aria-label="Keyless — the server holds no private key; it only reads public data.">Keyless</span
				>. By design.
			</h2>
		</div>

		<div class="space-y-6">
			<div
				class="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2"
			>
				<div class="bg-surface p-8">
					<svg
						class="h-5 w-5 text-text-muted"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
						<path d="M7 11V7a5 5 0 0 1 10 0v4" />
					</svg>
					<h3 class="mt-5 text-[15px] font-medium text-text">{INVARIANTS[0].title}</h3>
					<p class="mt-2 text-[13px] leading-relaxed text-text-muted">
						No signer, no write clients, no private keys anywhere under src/ —
						<span
							class="tip"
							role="button"
							tabindex="0"
							data-tooltip="An env var for a Stellar private key. This server ignores it on purpose and warns on stderr."
							aria-label="STELLAR_PRIVATE_KEY — an env var this server ignores on purpose.">STELLAR_PRIVATE_KEY</span
						>
						is ignored on purpose.
					</p>
					<details class="expand">
						<summary>Details</summary>
						<div>
							<p class="text-[13px] leading-relaxed text-text-muted">{INVARIANTS[0].body}</p>
						</div>
					</details>
				</div>

				<div class="bg-surface p-8">
					<svg
						class="h-5 w-5 text-text-muted"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<polyline points="4 17 10 11 4 5" />
						<line x1="12" x2="20" y1="19" y2="19" />
					</svg>
					<h3 class="mt-5 text-[15px] font-medium text-text">{INVARIANTS[1].title}</h3>
					<p class="mt-2 text-[13px] leading-relaxed text-text-muted">
						Every log goes to stderr, so the protocol stream is never corrupted by a stray print.
					</p>
					<details class="expand">
						<summary>Details</summary>
						<div>
							<p class="text-[13px] leading-relaxed text-text-muted">{INVARIANTS[1].body}</p>
						</div>
					</details>
				</div>

				<div class="bg-surface p-8">
					<svg
						class="h-5 w-5 text-text-muted"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<ellipse cx="12" cy="5" rx="9" ry="3" />
						<path d="M3 5V19A9 3 0 0 0 21 19V5" />
						<path d="M3 12A9 3 0 0 0 21 12" />
					</svg>
					<h3 class="mt-5 text-[15px] font-medium text-text">{INVARIANTS[2].title}</h3>
					<p class="mt-2 text-[13px] leading-relaxed text-text-muted">
						All agent text lives in labeled data slots — sanitized, length-bounded, never treated as
						instructions.
					</p>
					<details class="expand">
						<summary>Details</summary>
						<div>
							<p class="text-[13px] leading-relaxed text-text-muted">{INVARIANTS[2].body}</p>
						</div>
					</details>
				</div>

				<div class="bg-surface p-8">
					<svg
						class="h-5 w-5 text-text-muted"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<circle cx="12" cy="12" r="10" />
						<path d="m4.93 4.93 14.14 14.14" />
					</svg>
					<h3 class="mt-5 text-[15px] font-medium text-text">{INVARIANTS[3].title}</h3>
					<p class="mt-2 text-[13px] leading-relaxed text-text-muted">
						When verification can't be exhausted, status is unavailable and
						<span
							class="tip"
							role="button"
							tabindex="0"
							data-tooltip="The reputation fields authoritatively confirmed against the contract. Empty unless the read covers every declared field."
							aria-label="verifiedFields — fields confirmed against the contract; empty unless fully covered.">verifiedFields</span
						>
						stays empty.
					</p>
					<details class="expand">
						<summary>Details</summary>
						<div>
							<p class="text-[13px] leading-relaxed text-text-muted">{INVARIANTS[3].body}</p>
						</div>
					</details>
				</div>
			</div>

			<p class="text-[13px] text-text-dim">
				{TOOL_COUNT} tools · {RESOURCES.length} resources · {PROMPTS.length} prompts — all read-only.
				{#if PACKAGE_PUBLISHED}
					<a
						href="{GITHUB}/blob/main/docs/tools.md"
						target="_blank"
						rel="noopener noreferrer"
						class="underline decoration-border underline-offset-4 hover:decoration-accent hover:text-text-muted">docs/tools.md →</a
					>
				{/if}
			</p>
		</div>
	</section>

	<!-- ── Closing ─────────────────────────────────────────────────── -->
	<section use:reveal class="mt-48 border-t border-border pt-40 pb-32">
		<div class="space-y-12">
			<h2
				class="max-w-2xl text-[3rem] leading-[1.02] font-light tracking-[-0.04em] text-text sm:text-[4.5rem]"
			>
				Find the right agent.
			</h2>
			<p class="max-w-md text-[16px] leading-[1.6] text-text-muted">
				{#if PACKAGE_PUBLISHED}
					MCP for discovery. Canonical SDK for writes.
				{:else}
					Explorer and SDK are live. MCP source appears after ownership is verified.
				{/if}
			</p>
			<div class="pt-2">
				<CtaButton href={PACKAGE_PUBLISHED ? GITHUB : SDK_DOCS} size="lg" external>
					{PACKAGE_PUBLISHED ? 'GitHub' : 'Open SDK docs'}
					<svg
						class="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						stroke-width="2"
						aria-hidden="true"
					>
						<path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
					</svg>
				</CtaButton>
			</div>
		</div>
	</section>
</div>
