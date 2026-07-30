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
</script>

<svelte:head>
	<title>stellar-agent-search — discover and rank Stellar payment agents</title>
	<meta name="description" content="A read-only MCP server for discovering and ranking x402 payment agents on Stellar mainnet." />
	<link rel="canonical" href={SITE} />
	<meta property="og:title" content="stellar-agent-search" />
	<meta property="og:description" content="A read-only MCP server for discovering and ranking x402 payment agents on Stellar mainnet." />
	<meta property="og:url" content={SITE} />
	<meta property="og:type" content="website" />
	<meta name="twitter:card" content="summary" />
</svelte:head>

<div>
	<!-- Hero -->
	<section class="relative space-y-8 pt-4 sm:space-y-12 sm:pt-8">
		<AgentNetwork />

		<div class="reveal space-y-5 sm:space-y-7">
			<span class="text-[11px] tracking-[0.2em] text-text-dim uppercase">
				<a href={MCP_SPEC} target="_blank" rel="noopener noreferrer" class="hover:text-text-muted">MCP</a> · Stellar · x402
			</span>
			<h1 class="max-w-3xl text-[2.25rem] leading-[1.05] font-light tracking-[-0.035em] text-text sm:text-[4.5rem] sm:leading-[1.02] sm:tracking-[-0.04em]">
				Find the right<br />payment agent.
			</h1>
			<p class="max-w-md text-[15px] leading-[1.6] text-text-muted sm:text-[16px]">
				A read-only MCP server for <a href={EXPLORER} target="_blank" rel="noopener noreferrer" class="text-text underline decoration-border underline-offset-4 transition hover:decoration-accent">stellar-8004</a> agents that accept x402 micropayments. No key, no account.
			</p>
		</div>

		<div class="reveal reveal-d1">
			<VerdictCard />
		</div>

		<div class="reveal reveal-d2 space-y-3">
			<div class="flex flex-wrap items-center gap-3">
				<CtaButton href={PACKAGE_PUBLISHED ? '#install' : SDK_DOCS} size="md" external={!PACKAGE_PUBLISHED}>
					{PACKAGE_PUBLISHED ? 'Add to your client' : 'SDK docs'}
					<svg class="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
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

	<!-- Evidence -->
	<section id="why" class="mt-16 scroll-mt-24 border-t border-border pt-12 space-y-10 sm:mt-28 sm:pt-20 sm:space-y-14">
		<div class="space-y-3" use:reveal>
			<span class="text-[11px] tracking-[0.2em] text-text-dim uppercase">The trust gap</span>
			<h2 class="text-[1.5rem] leading-[1.1] font-light tracking-[-0.025em] text-text sm:text-[2.5rem] sm:leading-[1.1] sm:tracking-[-0.03em]">
				59–91% of agent reviewers are Sybils.
			</h2>
		</div>

		<div class="flex gap-8 sm:gap-12" use:reveal>
			<div>
				<p class="text-[1.5rem] font-light tabular-nums text-text sm:text-[2.5rem]">59<span class="text-text-dim">–91%</span></p>
				<p class="mt-1 text-[10px] tracking-[0.15em] text-text-dim uppercase">Sybil reviewers</p>
			</div>
			<div>
				<p class="text-[1.5rem] font-light tabular-nums text-text sm:text-[2.5rem]">3<span class="text-text-dim">–15%</span></p>
				<p class="mt-1 text-[10px] tracking-[0.15em] text-text-dim uppercase">Live endpoints</p>
			</div>
			<div>
				<p class="text-[1.5rem] font-light tabular-nums text-text sm:text-[2.5rem]">0</p>
				<p class="mt-1 text-[10px] tracking-[0.15em] text-text-dim uppercase">Fields verified</p>
			</div>
		</div>

		<div id="output" class="scroll-mt-24 space-y-6" use:reveal>
			<AgentRank />
			<HealthCheck />
		</div>
	</section>

	<!-- Guarantees -->
	<section id="guarantees" use:reveal class="mt-16 scroll-mt-24 border-t border-border pt-12 space-y-8 sm:mt-28 sm:pt-20 sm:space-y-12">
		<div class="space-y-3">
			<span class="text-[11px] tracking-[0.2em] text-text-dim uppercase">Guarantees</span>
			<h2 class="text-[1.5rem] leading-[1.1] font-light tracking-[-0.025em] text-text sm:text-[2.5rem] sm:leading-[1.1] sm:tracking-[-0.03em]">
				Read-only. Keyless. By design.
			</h2>
		</div>

		<ol class="divide-y divide-border">
			{#each INVARIANTS as inv, i (inv.title)}
				<li class="flex gap-4 py-4 sm:gap-6 sm:py-5">
					<span class="text-[12px] tabular-nums text-text-dim pt-0.5 shrink-0">{String(i + 1).padStart(2, '0')}</span>
					<div>
						<h3 class="text-[14px] font-medium text-text sm:text-[15px]">{inv.title}</h3>
						<p class="mt-0.5 text-[12px] leading-relaxed text-text-dim sm:mt-1 sm:text-[13px]">{inv.body}</p>
					</div>
				</li>
			{/each}
		</ol>
	</section>

	<!-- Closing -->
	<section use:reveal class="mt-16 border-t border-border pt-12 pb-10 sm:mt-28 sm:pt-20 sm:pb-20">
		<div class="space-y-6">
			<h2 class="text-[1.75rem] leading-[1.05] font-light tracking-[-0.03em] text-text sm:text-[3.5rem] sm:leading-[1.02] sm:tracking-[-0.04em]">
				Find the right agent.
			</h2>
			<CtaButton href={PACKAGE_PUBLISHED ? GITHUB : SDK_DOCS} size="lg" external>
				{PACKAGE_PUBLISHED ? 'GitHub' : 'Open SDK docs'}
				<svg class="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
			</CtaButton>
		</div>
	</section>
</div>
