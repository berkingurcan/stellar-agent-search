<script lang="ts">
	import CtaButton from '$lib/components/CtaButton.svelte';
	import AgentRank from '$lib/components/AgentRank.svelte';
	import AgentNetwork from '$lib/components/AgentNetwork.svelte';
	import HealthCheck from '$lib/components/HealthCheck.svelte';
	import VerdictCard from '$lib/components/VerdictCard.svelte';
	import { reveal } from '$lib/actions/reveal.js';
	import { PACKAGE_PUBLISHED } from '$lib/install.js';
	import { INVARIANTS } from '$lib/surface.js';
	import { EXPLORER, GITHUB, MCP_SPEC, SDK_DOCS, SITE } from '$lib/links.js';

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
	<section class="relative space-y-10 pt-4 sm:space-y-16 sm:pt-8">
		<AgentNetwork />

		<div class="reveal space-y-5 sm:space-y-8">
			<span class="text-[11px] tracking-[0.2em] text-text-dim uppercase">
				<a
					href={MCP_SPEC}
					target="_blank"
					rel="noopener noreferrer"
					class="hover:text-text-muted">MCP</a
				> · Stellar · x402
			</span>

			<h1
				class="max-w-3xl text-[2.25rem] leading-[1.05] font-light tracking-[-0.035em] text-text sm:text-[4.5rem] sm:leading-[1.02] sm:tracking-[-0.04em]"
			>
				Find the right<br />payment agent.
			</h1>

			<p class="max-w-md text-[15px] leading-[1.6] text-text-muted sm:text-[16px]">
				A read-only MCP server for
				<a
					href={EXPLORER}
					target="_blank"
					rel="noopener noreferrer"
					class="text-text underline decoration-border underline-offset-4 transition hover:decoration-accent"
					>stellar-8004</a
				>
				agents that accept x402 micropayments. No key, no account.
			</p>
		</div>

		<div class="reveal reveal-d1 max-w-2xl">
			<VerdictCard />
		</div>

		<div class="reveal reveal-d2 space-y-4">
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
					Pre-release · install commands stay withheld until public package ownership is verified
				{:else}
					Claude Code · Cursor · Windsurf · Cline · VS Code
				{/if}
			</p>
		</div>
	</section>

	<!-- ── Evidence ─────────────────────────────────────────────────── -->
	<section id="why" class="mt-20 scroll-mt-24 border-t border-border pt-16 space-y-12 sm:mt-32 sm:pt-24 sm:space-y-16">
		<div class="space-y-3 sm:space-y-4" use:reveal>
			<span class="text-[11px] tracking-[0.2em] text-text-dim uppercase">
				The trust gap
			</span>
			<h2
				class="max-w-2xl text-[1.5rem] leading-[1.1] font-light tracking-[-0.025em] text-text sm:text-[2.5rem] sm:leading-[1.1] sm:tracking-[-0.03em]"
			>
				59–91% of agent reviewers are Sybils.
			</h2>
		</div>

		<div
			class="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-border bg-border"
			use:reveal
		>
			<div class="bg-surface p-4 sm:p-8">
				<p class="text-[1.5rem] leading-none font-light tabular-nums text-text sm:text-[3rem]">
					59<span class="text-text-dim">–91%</span>
				</p>
				<p class="mt-2 text-[9px] tracking-[0.15em] text-text-dim uppercase sm:mt-3 sm:text-[10px]">
					Sybil reviewers
				</p>
			</div>
			<div class="bg-surface p-4 sm:p-8">
				<p class="text-[1.5rem] leading-none font-light tabular-nums text-text sm:text-[3rem]">
					3<span class="text-text-dim">–15%</span>
				</p>
				<p class="mt-2 text-[9px] tracking-[0.15em] text-text-dim uppercase sm:mt-3 sm:text-[10px]">
					Live endpoints
				</p>
			</div>
			<div class="bg-surface p-4 sm:p-8">
				<p class="text-[1.5rem] leading-none font-light tabular-nums text-text sm:text-[3rem]">0</p>
				<p class="mt-2 text-[9px] tracking-[0.15em] text-text-dim uppercase sm:mt-3 sm:text-[10px]">
					Fields verified
				</p>
			</div>
		</div>

		<div id="output" class="scroll-mt-24 space-y-8" use:reveal>
			<AgentRank />
			<HealthCheck />
		</div>
	</section>

	<!-- ── Guarantees ───────────────────────────────────────────────── -->
	<section
		id="guarantees"
		use:reveal
		class="mt-20 scroll-mt-24 border-t border-border pt-16 space-y-10 sm:mt-32 sm:pt-24 sm:space-y-16"
	>
		<div class="space-y-3 sm:space-y-4">
			<span class="text-[11px] tracking-[0.2em] text-text-dim uppercase">
				Guarantees
			</span>
			<h2
				class="max-w-2xl text-[1.5rem] leading-[1.1] font-light tracking-[-0.025em] text-text sm:text-[2.5rem] sm:leading-[1.1] sm:tracking-[-0.03em]"
			>
				Read-only. Keyless. By design.
			</h2>
		</div>

		<ol class="max-w-3xl divide-y divide-border">
			{#each INVARIANTS as inv, i (inv.title)}
				<li class="grid grid-cols-[1.5rem_1fr] gap-4 py-5 sm:gap-6 sm:py-6">
					<span class="text-[12px] tabular-nums text-text-dim pt-0.5">
						{String(i + 1).padStart(2, '0')}
					</span>
					<div>
						<h3 class="text-[14px] font-medium text-text sm:text-[15px]">{inv.title}</h3>
						<p class="mt-1 text-[13px] leading-relaxed text-text-dim sm:mt-1.5">{inv.body}</p>
					</div>
				</li>
			{/each}
		</ol>
	</section>

	<!-- ── Closing ─────────────────────────────────────────────────── -->
	<section use:reveal class="mt-20 border-t border-border pt-16 pb-12 sm:mt-32 sm:pt-24 sm:pb-24">
		<div class="space-y-6 sm:space-y-8">
			<h2
				class="max-w-xl text-[1.75rem] leading-[1.05] font-light tracking-[-0.03em] text-text sm:text-[3.5rem] sm:leading-[1.02] sm:tracking-[-0.04em]"
			>
				Find the right agent.
			</h2>
			<div>
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
