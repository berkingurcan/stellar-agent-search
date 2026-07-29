<script lang="ts">
	import CtaButton from '$lib/components/CtaButton.svelte';
	import Terminal from '$lib/components/Terminal.svelte';
	import VerdictCard from '$lib/components/VerdictCard.svelte';
	import { reveal } from '$lib/actions/reveal.js';
	import { PACKAGE_PUBLISHED } from '$lib/install.js';
	import { INVARIANTS, PROMPTS, RESOURCES, TOOL_COUNT, spellOut } from '$lib/surface.js';
	import { CAPTURED_ON, DOCTOR, RANK } from '$lib/transcripts.js';
	import { EXPLORER, GITHUB, MCP_SPEC, NPM, PAPER, SITE } from '$lib/links.js';

	const DESCRIPTION =
		'A read-only, keyless MCP server that discovers, ranks, and vets stellar-8004 agents on Stellar mainnet — and tells you exactly what it can verify about their reputation.';
</script>

<svelte:head>
	<title>stellar-agent-mcp — discover and rank Stellar agents</title>
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
	<section class="space-y-12">
		<div class="reveal flex items-center gap-2.5">
			<span class="h-1.5 w-1.5 rounded-full bg-text-muted"></span>
			<span class="font-mono text-[11px] tracking-[0.2em] text-text-dim uppercase">
				Model Context Protocol server
			</span>
		</div>

		<h1
			class="reveal reveal-d1 max-w-3xl text-[2.75rem] leading-[1.05] font-light tracking-[-0.035em] text-text sm:text-[4rem]"
		>
			Discover Stellar agents.<br />Verify what's provable.
		</h1>

		<p class="reveal reveal-d2 max-w-xl text-[16px] leading-[1.7] text-text-muted">
			A read-only, keyless MCP server that finds and ranks
			<a
				href={EXPLORER}
				target="_blank"
				rel="noopener noreferrer"
				class="text-text underline decoration-border underline-offset-4 transition hover:decoration-accent"
				>stellar-8004</a
			>
			agents on Stellar mainnet. Agent directories list self-declared reputation, and a 2026 study found
			<span class="text-text tabular-nums">59&ndash;91%</span> of reviewers are Sybils. This server
			checks each agent against the on-chain Reputation contract and tells you exactly what it can
			verify &mdash; and what stays unverified.
		</p>

		<div class="reveal reveal-d3 max-w-2xl">
			<VerdictCard />
		</div>

		<div class="reveal reveal-d3 flex flex-col gap-5">
			{#if !PACKAGE_PUBLISHED}
				<p class="text-[13px] leading-relaxed text-text-dim">
					Pre-release &mdash; install lands when stellar-agent-mcp@0.1.0 hits
					<a
						class="underline hover:text-text-muted"
						href={NPM}
						target="_blank"
						rel="noopener noreferrer">npm</a
					>.
				</p>
			{/if}

			<div class="flex flex-wrap items-center gap-3">
				<CtaButton href={PACKAGE_PUBLISHED ? '#install' : GITHUB} size="md" external={!PACKAGE_PUBLISHED}>
					{PACKAGE_PUBLISHED ? 'Add to your client' : 'Star on GitHub'}
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
			</div>

			<p class="font-mono text-[11px] text-text-dim">
				Runs in Claude Code, Cursor, Windsurf, Cline, and VS Code.
			</p>
		</div>
	</section>

	<!-- ── Evidence ─────────────────────────────────────────────────── -->
	<section id="why" use:reveal class="mt-32 scroll-mt-24 border-t border-border pt-32 space-y-10">
		<div class="space-y-6">
			<span class="font-mono text-[11px] tracking-[0.2em] text-text-dim uppercase">
				Evidence boundary
			</span>
			<h2
				class="max-w-2xl text-[1.875rem] leading-[1.15] font-normal tracking-[-0.025em] text-text sm:text-[2.25rem]"
			>
				Declared reputation, checked against the chain
			</h2>
		</div>

		<div class="max-w-2xl space-y-6 text-[16px] leading-[1.7] text-text-muted">
			<p>
				Agent directories &mdash; A2A cards, the MCP Registry, OASF, NANDA &mdash; list
				<span class="text-text">self-declared</span> agents. A 2026 study found 3&ndash;15% of
				registrations have a live endpoint and 59&ndash;91% of reviewers are Sybils
				(<a
					href={PAPER}
					target="_blank"
					rel="noopener noreferrer"
					class="text-text underline decoration-border underline-offset-4 transition hover:decoration-accent"
					>arXiv 2606.26028</a
				>). A registry entry is the agent&rsquo;s own account of itself.
			</p>
			<p>
				This server ranks agents on that declared data, then checks each one against the on-chain
				Reputation contract. The contract read is bounded &mdash; a single page can&rsquo;t prove the
				full client list is complete &mdash; so the server reports the contract as reachable but
				verifies no reputation fields. Ranking multiplies Explorer quality by a fixed evidence score
				(0.4 volume + 0.6 client breadth). It&rsquo;s a cost-of-manipulation proxy, not a Sybil proof.
			</p>
		</div>

		<div class="max-w-2xl space-y-6">
			<p class="font-mono text-[11px] tracking-[0.2em] text-text-dim uppercase">
				Output &mdash; captured {CAPTURED_ON}
			</p>
			<div class="space-y-6">
				<Terminal command={RANK.command} output={RANK.output} caption={RANK.caption} />
				<Terminal command={DOCTOR.command} output={DOCTOR.output} />
			</div>
			<p class="text-[13px] leading-relaxed text-text-dim">
				{TOOL_COUNT} read-only tools, {RESOURCES.length} resources, {PROMPTS.length} prompts behind
				these commands &mdash;
				<a
					href="{GITHUB}/blob/main/docs/tools.md"
					target="_blank"
					rel="noopener noreferrer"
					class="underline decoration-border underline-offset-4 transition hover:decoration-accent hover:text-text-muted"
					>docs/tools.md &rarr;</a
				>
			</p>
		</div>
	</section>

	<!-- ── Guarantees ───────────────────────────────────────────────── -->
	<section
		id="guarantees"
		use:reveal
		class="mt-32 scroll-mt-24 border-t border-border pt-32 space-y-10"
	>
		<div class="space-y-6">
			<span class="font-mono text-[11px] tracking-[0.2em] text-text-dim uppercase">
				Guarantees
			</span>
			<h2
				class="max-w-2xl text-[1.875rem] leading-[1.15] font-normal tracking-[-0.025em] text-text sm:text-[2.25rem]"
			>
				{spellOut(INVARIANTS.length)} guarantees, enforced in CI
			</h2>
		</div>

		<ol class="max-w-3xl divide-y divide-border">
			{#each INVARIANTS as inv, i (inv.title)}
				<li class="grid grid-cols-[2rem_1fr] gap-6 py-6">
					<span class="font-mono text-[12px] tabular-nums text-text-dim pt-1">
						{String(i + 1).padStart(2, '0')}
					</span>
					<div class="space-y-2">
						<h3 class="text-[15px] font-medium text-text">{inv.title}</h3>
						<p class="text-[14px] leading-relaxed text-text-muted">{inv.body}</p>
					</div>
				</li>
			{/each}
		</ol>

		{#if PACKAGE_PUBLISHED}
			<div id="install" class="border-t border-border pt-10 space-y-6">
				<span class="font-mono text-[11px] tracking-[0.2em] text-text-dim uppercase">
					Install
				</span>
				<h2
					class="max-w-2xl text-[1.875rem] leading-[1.15] font-normal tracking-[-0.025em] text-text sm:text-[2.25rem]"
				>
					One command in your MCP client
				</h2>
				<p class="max-w-xl text-[15px] leading-relaxed text-text-muted">
					Speaks
					<a
						href={MCP_SPEC}
						target="_blank"
						rel="noopener noreferrer"
						class="text-text underline decoration-border underline-offset-4 transition hover:decoration-accent"
						>MCP</a
					>
					over stdio to Claude Code, Cursor, Windsurf, Cline, and VS Code. Node 22 or newer. No key,
					no account.
				</p>
			</div>
		{/if}
	</section>

	<!-- ── Closing ─────────────────────────────────────────────────── -->
	<section use:reveal class="mt-32 border-t border-border pt-32 space-y-6">
		<h2
			class="max-w-xl text-[2rem] leading-[1.12] font-light tracking-[-0.025em] text-text sm:text-[2.5rem]"
		>
			Star now. Install at 0.1.0.
		</h2>
		<p class="max-w-md text-[15px] leading-relaxed text-text-muted">
			The build passes and the transcripts above are real. Watch the repo for the release tag.
		</p>
		<div class="pt-2">
			<CtaButton href={GITHUB} size="lg" external>
				Star on GitHub
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
	</section>
</div>
