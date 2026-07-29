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

<div class="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-5">
	{#each VERDICTS as v (v.key)}
		<div class="bg-surface p-4">
			<div class="flex items-center gap-2">
				<span class="h-1.5 w-1.5 rounded-full {TONE[v.tone].dot}"></span>
				<code class="font-mono text-[11.5px] {TONE[v.tone].text}">{v.key}</code>
			</div>
			<p class="mt-2 text-[11.5px] leading-relaxed text-text-dim">{v.meaning}</p>
		</div>
	{/each}
</div>
