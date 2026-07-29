<script lang="ts">
	// Renders a real CLI transcript. Every string passed in was captured by
	// actually running the command — see src/lib/transcripts.ts.
	//
	// Highlighting is done by splitting each line into typed segments in JS and
	// rendering them as <span>s. Deliberately no {@html}: nothing here needs to
	// inject markup, so the component has no HTML-injection surface at all.

	let {
		command,
		output,
		caption = undefined
	}: { command: string; output: string; caption?: string } = $props();

	type Seg = { t: string; c: string };

	// Verification verdicts get the same semantic colours the design system
	// assigns them everywhere else: verified = positive, partial/mismatch =
	// caution, unavailable/skipped = dim.
	const TOKENS: [RegExp, string][] = [
		[/\bverified\b/g, 'term-ok'],
		[/✔/g, 'term-ok'],
		[/\bpartial\b/g, 'term-warn'],
		[/\bmismatch\b/g, 'term-warn'],
		[/\b(?:unavailable|skipped)\b/g, 'term-dim'],
		[/ℹ/g, 'term-dim']
	];

	const RE = new RegExp(TOKENS.map(([r]) => r.source).join('|'), 'g');

	function classify(word: string): string {
		for (const [re, cls] of TOKENS) {
			re.lastIndex = 0;
			if (re.test(word)) return cls;
		}
		return '';
	}

	function segment(line: string): Seg[] {
		const segs: Seg[] = [];
		let last = 0;
		RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = RE.exec(line)) !== null) {
			if (m.index > last) segs.push({ t: line.slice(last, m.index), c: '' });
			segs.push({ t: m[0], c: classify(m[0]) });
			last = m.index + m[0].length;
		}
		if (last < line.length) segs.push({ t: line.slice(last), c: '' });
		return segs;
	}

	const lines = $derived(output.split('\n').map(segment));
</script>

<figure class="m-0 overflow-hidden rounded-md border border-border">
	<!-- Prompt line: the exact command that produced the output below -->
	<div class="flex items-center gap-2.5 border-b border-border bg-surface px-3.5 py-2.5">
		<span class="font-mono text-[10px] text-text-dim select-none">$</span>
		<code class="min-w-0 flex-1 truncate font-mono text-[11px] text-text-muted">{command}</code>
	</div>

	<div class="term overflow-x-auto px-3.5 py-3">
		<pre class="whitespace-pre">{#each lines as line, i (i)}{#each line as seg, j (j)}{#if seg.c}<span
							class={seg.c}>{seg.t}</span
						>{:else}{seg.t}{/if}{/each}{#if i < lines.length - 1}{'\n'}{/if}{/each}</pre>
	</div>

	{#if caption}
		<figcaption
			class="border-t border-border bg-surface-raised px-3.5 py-2.5 text-[11px] leading-relaxed text-text-dim"
		>
			{caption}
		</figcaption>
	{/if}
</figure>
