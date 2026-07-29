<script lang="ts">
	import CodeBlock from '$lib/components/CodeBlock.svelte';
	import CopyCommand from '$lib/components/CopyCommand.svelte';
	import CtaButton from '$lib/components/CtaButton.svelte';
	import LiveStats from '$lib/components/LiveStats.svelte';
	import Terminal from '$lib/components/Terminal.svelte';
	import VerdictCard from '$lib/components/VerdictCard.svelte';
	import VerdictLegend from '$lib/components/VerdictLegend.svelte';
	import {
		CONFIGS,
		INVARIANTS,
		PACKAGE_PUBLISHED,
		PROMPTS,
		RESOURCES,
		TIER0,
		TIER1,
		TOOL_COUNT,
		spellOut
	} from '$lib/surface.js';
	import { CAPTURED_ON, DOCTOR, PROFILE, RANK } from '$lib/transcripts.js';
	import { EXPLORER, GITHUB, MCP_SPEC, NPM, PAPER, SITE } from '$lib/links.js';

	const HERO_CMD = 'npx -y stellar-agent-mcp@0.1.0 find "a paid web scraper with a good reputation"';

	const DESCRIPTION =
		'A read-only, keyless MCP server for stellar-8004 agents on Stellar mainnet. It finds and ranks agents, performs bounded on-chain reputation checks, and reports exactly which fields agree or remain unverified.';

	// Plain toggle buttons, not ARIA tabs. A tablist implies arrow-key navigation
	// and a linked tabpanel; announcing "tab 1 of 3" and then not moving on arrow
	// press is worse for a screen reader than no roles at all.
	let activeConfig = $state(CONFIGS[0].id);
	const config = $derived(CONFIGS.find((c) => c.id === activeConfig) ?? CONFIGS[0]);
</script>

<svelte:head>
	<title>stellar-agent-mcp — on-chain-checked agent discovery on Stellar</title>
	<meta name="description" content={DESCRIPTION} />
	<link rel="canonical" href={SITE} />
	<meta property="og:title" content="stellar-agent-mcp" />
	<meta property="og:description" content={DESCRIPTION} />
	<meta property="og:url" content={SITE} />
	<meta property="og:type" content="website" />
	<meta name="twitter:card" content="summary" />
</svelte:head>

<div>
	<!-- ── Hero ─────────────────────────────────────────────────────────── -->
	<section class="space-y-8">
		<div class="reveal flex items-center gap-2.5">
			<span class="h-1.5 w-1.5 rounded-full bg-positive"></span>
			<span class="text-[11px] tracking-[0.25em] text-text-muted uppercase">
				Model Context Protocol server
			</span>
		</div>

		<h1
			class="reveal reveal-d1 max-w-3xl text-[2.1rem] leading-[1.1] font-light tracking-[-0.02em] text-text sm:text-[3rem]"
		>
			Agent reputation, checked against the contract it came from.
		</h1>

		<div class="grid gap-10 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-start lg:gap-12">
			<div class="reveal reveal-d2 space-y-7">
				<p class="max-w-lg text-[15px] leading-relaxed font-light text-text-muted">
					A read-only, keyless server for
					<a
						href={EXPLORER}
						target="_blank"
						rel="noopener noreferrer"
						class="text-accent underline decoration-accent/30 underline-offset-4 transition hover:decoration-accent"
						>stellar-8004</a
					>
					agents on Stellar mainnet. It finds and ranks agents, performs bounded checks against the
					on-chain Reputation contract, and reports which fields agree or remain unverified.
				</p>

				<div class="max-w-lg space-y-3">
					{#if PACKAGE_PUBLISHED}
						<CopyCommand command={HERO_CMD} />
					{:else}
						<div
							role="status"
							class="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-[12px] leading-relaxed text-text-muted"
						>
							<strong class="font-medium text-warning">Pre-release:</strong> the npm package name is not
							yet owned by this project. Do not run any <code>npx stellar-agent-mcp</code> command until
							<a class="underline" href={NPM} target="_blank" rel="noopener noreferrer">the official npm page</a>
							shows version 0.1.0.
						</div>
					{/if}
					<div class="flex flex-wrap items-center gap-2.5">
						<CtaButton href={PACKAGE_PUBLISHED ? '#install' : GITHUB} size="md" external={!PACKAGE_PUBLISHED}>
							{PACKAGE_PUBLISHED ? 'Add to your client' : 'Release status'}
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
						<CtaButton href={GITHUB} variant="secondary" size="md" external>GitHub</CtaButton>
						{#if PACKAGE_PUBLISHED}
							<CtaButton href={NPM} variant="ghost" size="md" external>npm</CtaButton>
						{/if}
					</div>
				</div>
			</div>

			<div class="reveal reveal-d3">
				<VerdictCard />
			</div>
		</div>
	</section>

	<!-- The vocabulary, straight after the example that used it. -->
	<section class="mt-10 space-y-3">
		<p class="text-[11px] tracking-[0.2em] text-text-dim uppercase">
			Each check returns one of five states
		</p>
		<VerdictLegend />
	</section>

	<!-- ── Why ──────────────────────────────────────────────────────────── -->
	<section id="why" class="mt-28 scroll-mt-24 space-y-8">
		<div class="space-y-4">
			<h2 class="text-[11px] tracking-[0.25em] text-text-dim uppercase">Verification</h2>
			<p class="max-w-2xl text-2xl leading-snug font-light tracking-tight text-text sm:text-[2rem]">
				Why re-derive what the registry already reports
			</p>
		</div>

		<div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
			<div class="space-y-5 text-[15px] leading-relaxed font-light text-text-muted">
				<p>
					Off-chain agent directories &mdash; A2A cards, the MCP Registry, OASF, NANDA &mdash; list
					<span class="text-text">self-declared</span> agents. A 2026 study of the ERC-8004 ecosystem
					found that 3&ndash;15% of registrations have a live endpoint and 59&ndash;91% of reviewers
					are Sybils.
				</p>
				<p>
					A registry entry is the agent&rsquo;s own account of itself. The reputation figure in it,
					though, originates on-chain &mdash; so it can be read back. This server reads it directly
					from the Reputation contract
					(<code class="font-mono text-[13px] text-text">get_summary</code> and
					<code class="font-mono text-[13px] text-text">get_clients_paginated</code>) and reports
					both figures side by side. The live contract accepts at most five comparable client
					addresses per summary, so a matching average/count is labeled <code>partial</code> until
					active unique-client breadth is independently derivable.
				</p>
				<p>
					Ranking follows the same reasoning: unique clients are weighted above raw feedback volume,
					since distinct counterparties are harder to acquire than repeat reviews. Agent-authored
					text &mdash; names, descriptions, service labels, feedback tags &mdash; is carried as data
					and never as instructions.
				</p>
			</div>

			<aside class="space-y-3">
				<div class="rounded-xl border border-border bg-surface-raised/40 p-5">
					<p class="text-[10.5px] tracking-wide text-text-dim uppercase">The study</p>
					<p class="mt-3 text-[13px] leading-relaxed text-text-muted">
						<a
							href={PAPER}
							target="_blank"
							rel="noopener noreferrer"
							class="text-accent underline decoration-accent/30 underline-offset-4 transition hover:decoration-accent"
							>arXiv 2606.26028</a
						>, <em>Can Trustless Agents Be Trusted?</em>
					</p>
					<dl class="mt-4 space-y-3">
						<div>
							<dt class="text-[10.5px] tracking-wide text-text-dim uppercase">Live endpoints</dt>
							<dd class="mt-1 text-[1.5rem] leading-none font-light tabular-nums text-negative">
								3&ndash;15%
							</dd>
						</div>
						<div>
							<dt class="text-[10.5px] tracking-wide text-text-dim uppercase">Sybil reviewers</dt>
							<dd class="mt-1 text-[1.5rem] leading-none font-light tabular-nums text-negative">
								59&ndash;91%
							</dd>
						</div>
					</dl>
				</div>

				<!-- The one claim this project is careful not to overstate. -->
				<p class="px-1 text-[11px] leading-relaxed text-text-dim">
					The study covers Ethereum, BSC and Base by design. stellar-8004 is the only non-EVM
					ERC-8004 implementation <em>we are aware of</em> running on mainnet; no published survey
					enumerates non-EVM deployments, so the claim is unrefuted rather than proven.
				</p>
			</aside>
		</div>
	</section>

	<!-- ── Output ───────────────────────────────────────────────────────── -->
	<section id="output" class="mt-28 scroll-mt-24 space-y-8">
		<div class="space-y-4">
			<h2 class="text-[11px] tracking-[0.25em] text-text-dim uppercase">Output</h2>
			<p class="max-w-2xl text-2xl leading-snug font-light tracking-tight text-text sm:text-[2rem]">
				Three commands, run against mainnet
			</p>
			<p class="max-w-xl text-[15px] leading-relaxed font-light text-text-muted">
				Captured from a local release build against live mainnet on {CAPTURED_ON}. The shape is stable; the numbers move
				with the chain.
			</p>
		</div>

		<!-- Full width, stacked. Two columns squeezed these to ~480px and clipped
		     every table header and score-breakdown line. -->
		<div class="space-y-5">
			<Terminal command={RANK.command} output={RANK.output} caption={RANK.caption} />
			<Terminal command={PROFILE.command} output={PROFILE.output} caption={PROFILE.caption} />

			<div class="space-y-3 pt-3">
				<p class="max-w-2xl text-[13px] leading-relaxed font-light text-text-muted">
					<code class="font-mono text-text">doctor</code> checks the environment before you rely on
					an answer: Node version, network, the keyless invariant, explorer reachability and
					freshness, Soroban RPC, and one live reputation read.
				</p>
				<Terminal command={DOCTOR.command} output={DOCTOR.output} />
			</div>
		</div>
	</section>

	<!-- ── Install ──────────────────────────────────────────────────────── -->
	<section id="install" class="mt-28 scroll-mt-24 space-y-8">
		<div class="space-y-4">
			<h2 class="text-[11px] tracking-[0.25em] text-text-dim uppercase">Install</h2>
			<p class="max-w-2xl text-2xl leading-snug font-light tracking-tight text-text sm:text-[2rem]">
				One command in your MCP client
			</p>
			<p class="max-w-xl text-[15px] leading-relaxed font-light text-text-muted">
				Speaks
				<a
					href={MCP_SPEC}
					target="_blank"
					rel="noopener noreferrer"
					class="text-accent underline decoration-accent/30 underline-offset-4 transition hover:decoration-accent"
					>MCP</a
				> over stdio to Claude Code, Cursor, Windsurf, Cline and VS Code, and runs as a terminal tool.
				Node 20 or newer. No key, no account.
			</p>
		</div>

		{#if PACKAGE_PUBLISHED}
		<div class="space-y-4">
			<div class="flex flex-wrap gap-1.5">
				{#each CONFIGS as c (c.id)}
					<button
						type="button"
						aria-pressed={activeConfig === c.id}
						onclick={() => (activeConfig = c.id)}
						class="rounded-lg border px-3.5 py-1.5 text-[11.5px] font-medium transition-colors
						       {activeConfig === c.id
							? 'border-accent/30 bg-accent-fill text-accent'
							: 'border-border bg-surface text-text-muted hover:border-border-subtle hover:text-text'}"
					>
						{c.label}
					</button>
				{/each}
			</div>

			{#key config.id}
				<div class="space-y-2.5">
					<CodeBlock code={config.code} lang={config.lang} />
					<p class="max-w-2xl text-[11.5px] leading-relaxed text-text-dim">{config.note}</p>
				</div>
			{/key}
		</div>
		{:else}
			<div class="rounded-xl border border-warning/30 bg-warning/10 p-5 text-[13px] leading-relaxed text-text-muted">
				Install commands are intentionally withheld until the official npm package exists. This prevents
				an unclaimed package name from becoming an arbitrary-code execution path. Release status is tracked
				on GitHub.
			</div>
		{/if}
	</section>

	<!-- ── Surface ──────────────────────────────────────────────────────── -->
	<section id="tools" class="mt-28 scroll-mt-24 space-y-8">
		<div class="space-y-4">
			<h2 class="text-[11px] tracking-[0.25em] text-text-dim uppercase">Surface</h2>
			<p class="max-w-2xl text-2xl leading-snug font-light tracking-tight text-text sm:text-[2rem]">
				{TOOL_COUNT} tools, {RESOURCES.length} resources, {PROMPTS.length} prompts &mdash; all read-only
			</p>
		</div>

		<!-- Tier 0 gets prose; Tier 1 is named only. Thirteen rows of
		     name-plus-sentence is reference material, and docs/tools.md is one click
		     away. -->
		<div class="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
			{#each TIER0 as tool (tool.name)}
				<div class="bg-surface p-5">
					<code class="font-mono text-[12.5px] text-accent">{tool.name}</code>
					<p class="mt-2 text-[13px] leading-relaxed text-text-muted">{tool.what}</p>
				</div>
			{/each}
		</div>

		<div class="rounded-xl border border-border bg-surface-raised/30 p-5">
			<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
				<p class="text-[10.5px] tracking-wide text-text-dim uppercase">
					{TIER1.length} more, same read-only contract
				</p>
				<a
					href="{GITHUB}/blob/main/docs/tools.md"
					target="_blank"
					rel="noopener noreferrer"
					class="text-[11px] text-text-dim transition hover:text-accent"
				>
					Inputs, outputs and defaults in docs/tools.md &rarr;
				</a>
			</div>
			<div class="mt-4 flex flex-wrap gap-1.5">
				{#each TIER1 as tool (tool.name)}
					<code
						class="rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 font-mono text-[11px] text-text-muted"
						title={tool.what}>{tool.name}</code
					>
				{/each}
			</div>
		</div>

		<div class="grid gap-5 sm:grid-cols-2">
			<div class="rounded-xl border border-border bg-surface-raised/30 p-5">
				<p class="text-[10.5px] tracking-wide text-text-dim uppercase">Resources</p>
				<p class="mt-3 text-[13px] leading-relaxed text-text-muted">
					Each <code class="font-mono text-[12px] text-text">stellar8004://</code> URI returns JSON
					and rendered markdown in one payload, so a client can pin it as context.
				</p>
				<div class="mt-4 flex flex-wrap gap-1.5">
					{#each RESOURCES as r (r)}
						<code
							class="rounded-md border border-border-subtle bg-surface px-2 py-1 font-mono text-[10.5px] text-text-muted"
							>{r}</code
						>
					{/each}
				</div>
			</div>

			<div class="rounded-xl border border-border bg-surface-raised/30 p-5">
				<p class="text-[10.5px] tracking-wide text-text-dim uppercase">Prompts</p>
				<p class="mt-3 text-[13px] leading-relaxed text-text-muted">
					<code class="font-mono text-[12px] text-text">prepare-x402-call</code> lays out the payment
					flow and stops before signing. The server holds no keys.
				</p>
				<div class="mt-4 flex flex-wrap gap-1.5">
					{#each PROMPTS as p (p.name)}
						<code
							class="rounded-md border border-border-subtle bg-surface px-2 py-1 font-mono text-[10.5px] text-text-muted"
						>
							{p.name}{#if p.note}<span class="text-text-dim"> · {p.note}</span>{/if}
						</code>
					{/each}
				</div>
			</div>
		</div>
	</section>

	<!-- ── Guarantees ───────────────────────────────────────────────────── -->
	<section id="guarantees" class="mt-28 scroll-mt-24 space-y-8">
		<div class="space-y-4">
			<h2 class="text-[11px] tracking-[0.25em] text-text-dim uppercase">Guarantees</h2>
			<p class="max-w-2xl text-2xl leading-snug font-light tracking-tight text-text sm:text-[2rem]">
				{spellOut(INVARIANTS.length)} invariants, enforced in CI
			</p>
		</div>

		<div class="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
			{#each INVARIANTS as inv (inv.title)}
				<div class="bg-surface p-6">
					<div class="flex items-center gap-2.5">
						<svg
							class="h-3.5 w-3.5 shrink-0 text-positive"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="2.5"
							aria-hidden="true"
						>
							<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
						</svg>
						<h3 class="text-[13.5px] font-medium text-text">{inv.title}</h3>
					</div>
					<p class="mt-3 text-[13px] leading-relaxed font-light text-text-muted">{inv.body}</p>
				</div>
			{/each}
		</div>

		<LiveStats />
	</section>

	<!-- ── Closing ──────────────────────────────────────────────────────── -->
	<section
		class="cta-banner group/cta relative mt-28 overflow-hidden rounded-2xl border border-border bg-linear-to-br from-surface-raised via-surface-overlay to-surface-raised p-8 sm:p-12"
	>
		<div class="pointer-events-none absolute inset-0 cta-noise"></div>
		<div class="cta-leak cta-leak--warm"></div>
		<div class="cta-leak cta-leak--cool"></div>
		<div class="cta-leak cta-leak--edge"></div>

		<div class="relative z-10 grid gap-10 sm:grid-cols-[1fr_auto] sm:items-center">
			<div class="space-y-5">
				<span
					class="inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-accent/6 px-3 py-1 text-[10px] tracking-[0.18em] text-accent uppercase"
				>
					<span class="h-1 w-1 animate-pulse rounded-full bg-accent"></span>
					Read-only &middot; keyless
				</span>

				<h2 class="max-w-md text-2xl font-light tracking-tight text-text sm:text-[2rem]">
					Reviewing this against a grant or SOW?
				</h2>

				<p class="max-w-md text-[15px] leading-relaxed font-light text-text-muted">
					<code class="font-mono text-[13px] text-text">docs/evidence.md</code> maps each deliverable
					to its evidence with the steps to verify it, written to be checked without a technical
					background. Open work is tracked one file per issue.
				</p>
			</div>

			<div class="flex flex-col items-start gap-3 sm:items-end">
				<CtaButton href="{GITHUB}/blob/main/docs/evidence.md" size="lg" external>
					Read the evidence map
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
				<a
					href="{GITHUB}/tree/main/issues"
					target="_blank"
					rel="noopener noreferrer"
					class="text-[11px] text-text-dim transition hover:text-text-muted"
				>
					Open issues, one file each &rarr;
				</a>
			</div>
		</div>
	</section>
</div>
