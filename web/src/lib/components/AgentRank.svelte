<script lang="ts">
	import { reveal } from '$lib/actions/reveal.js';

	const agents = [
		{ rank: 1, name: 'Scrapper Agent', id: 10, score: 50, x402: true },
		{ rank: 2, name: 'Crawler Scraper Agent', id: 6, score: 19, x402: false }
	];
</script>

<div class="space-y-px border-y border-border">
	{#each agents as agent, i (agent.id)}
		<div use:reveal={i * 80} class="flex items-baseline justify-between gap-4 py-4">
			<div class="flex items-baseline gap-3 min-w-0">
				<span class="text-[1.25rem] font-light tabular-nums text-text-dim">{agent.rank}</span>
				<span class="text-[14px] font-medium text-text truncate">{agent.name}</span>
				{#if agent.x402}
					<span class="text-[10px] text-text-dim shrink-0">x402</span>
				{/if}
			</div>
			<span class="text-[1.25rem] font-light tabular-nums text-text shrink-0">
				{agent.score}<span class="text-text-dim text-[0.85rem]">/100</span>
			</span>
		</div>
	{/each}
</div>
