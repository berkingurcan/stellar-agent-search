<script lang="ts">
	// The four verdicts, stated once, prominently. Without this the semantic colours
	// used across the page and in every CLI transcript are decoration; with it they
	// are a vocabulary the reader now knows.
	import { VERDICTS } from '$lib/transcripts.js';

	const TONE: Record<string, { dot: string; text: string }> = {
		positive: { dot: 'bg-positive', text: 'text-positive' },
		accent: { dot: 'bg-accent', text: 'text-accent' },
		warning: { dot: 'bg-warning', text: 'text-warning' },
		dim: { dot: 'bg-text-dim', text: 'text-text-dim' }
	};
</script>

<div class="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
	{#each VERDICTS as v (v.key)}
		<div class="flex items-baseline gap-2">
			<span class="mt-[2px] h-1.5 w-1.5 shrink-0 rounded-full {TONE[v.tone].dot}"></span>
			<div>
				<code class="font-mono text-[11px] {TONE[v.tone].text}">{v.key}</code>
				<span class="text-[11px] text-text-dim"> &mdash; {v.meaning}</span>
			</div>
		</div>
	{/each}
</div>
