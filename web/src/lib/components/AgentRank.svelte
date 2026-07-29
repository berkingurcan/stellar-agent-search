<script lang="ts">
	import { RANK } from '$lib/transcripts.js';
	import { reveal } from '$lib/actions/reveal.js';

	const agents = [
		{
			rank: 1,
			id: 10,
			name: 'Scrapper Agent',
			score: 50,
			status: 'unavailable',
			x402: true,
			services: 1
		},
		{
			rank: 2,
			id: 6,
			name: 'Crawler Scraper Agent',
			score: 19,
			status: 'unavailable',
			x402: false,
			services: 1
		}
	];
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between border-b border-border-subtle pb-3">
		<span class="text-[11px] tracking-[0.15em] text-text-dim uppercase">Ranking</span>
		<span class="text-[11px] text-text-dim">"{RANK.command.match(/"(.+)"/)?.[1] ?? 'query'}"</span>
	</div>

	{#each agents as agent, i (agent.id)}
		<div
			use:reveal={i * 100}
			class="rounded-md border border-border bg-surface-raised p-5"
		>
			<div class="flex items-center justify-between gap-4">
				<div class="flex items-center gap-3 min-w-0">
					<span class="text-[1.75rem] leading-none font-light tabular-nums text-text-dim">
						{agent.rank}
					</span>
					<div class="min-w-0">
						<p class="text-[14px] font-medium text-text truncate">{agent.name}</p>
						<p class="text-[11px] text-text-dim">#{agent.id} · self-declared</p>
					</div>
				</div>
				<div class="flex items-center gap-3 shrink-0">
					{#if agent.x402}
						<span class="rounded border border-border-subtle px-2 py-0.5 text-[10px] font-medium text-text-muted">
							x402
						</span>
					{/if}
					<span class="text-[1.5rem] leading-none font-light tabular-nums text-text">
						{agent.score}
						<span class="text-[1rem] text-text-dim">/100</span>
					</span>
				</div>
			</div>

			<div class="mt-4 h-[3px] overflow-hidden rounded-full bg-border-subtle">
				<div
					class="h-full rounded-full bg-text-muted transition-all duration-700"
					style="width: {agent.score}%"
				></div>
			</div>

			<div class="mt-3 flex items-center gap-2">
				<span class="h-1.5 w-1.5 rounded-full bg-text-dim"></span>
				<span class="text-[11px] text-text-dim">
					{agent.status} — contract reachable, fields not verified
				</span>
			</div>
		</div>
	{/each}

	<p class="pt-2 text-[11px] text-text-dim">
		Bounded scan: 66 records across 2 pages · not registry-global
	</p>
</div>
