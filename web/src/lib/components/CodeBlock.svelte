<script lang="ts">
	import { theme } from '$lib/theme.svelte.js';

	let {
		code,
		lang = 'json',
		class: className = ''
	}: { code: string; lang?: string; class?: string } = $props();

	// Plain text until shiki resolves, so the block is never blank and is
	// still readable if the highlighter fails to load.
	let html = $state('');

	$effect(() => {
		const shikiTheme = theme.resolved === 'light' ? 'github-light-default' : 'github-dark-default';
		const [c, l] = [code, lang];
		let cancelled = false;
		// Imported lazily so shiki's core never lands in the initial page chunk —
		// the blocks are below the fold and readable as plain text until it arrives.
		import('$lib/highlighter.js')
			.then(({ getHighlighter }) => getHighlighter())
			.then((hl) => {
				if (!cancelled) html = hl.codeToHtml(c, { lang: l, theme: shikiTheme });
			})
			.catch(() => {
				// Leave `html` empty — the plain-text fallback below stays visible.
			});
		return () => {
			cancelled = true;
		};
	});
</script>

<div
	class="overflow-x-auto rounded-md border border-border bg-code p-3.5 font-mono text-[11.5px] leading-relaxed {className}"
>
	{#if html}
		{@html html}
	{:else}
		<pre class="whitespace-pre text-text-muted">{code}</pre>
	{/if}
</div>

<style>
	:global(.shiki) {
		background: transparent !important;
	}
</style>
