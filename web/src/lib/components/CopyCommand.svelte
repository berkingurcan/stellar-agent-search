<script lang="ts">
	let {
		command,
		size = 'md'
	}: { command: string; size?: 'sm' | 'md' } = $props();

	let copied = $state(false);
	let failed = $state(false);
	let timer: ReturnType<typeof setTimeout>;

	async function copy() {
		clearTimeout(timer);
		try {
			await navigator.clipboard.writeText(command);
			copied = true;
			failed = false;
		} catch {
			// Clipboard API needs a secure context and can be blocked by policy.
			// Say so rather than showing a checkmark for something that didn't happen.
			failed = true;
			copied = false;
		}
		timer = setTimeout(() => {
			copied = false;
			failed = false;
		}, 1800);
	}

	const pad = $derived(size === 'sm' ? 'px-3 py-1.5 text-[10.5px]' : 'px-3.5 py-2.5 text-[11.5px]');
</script>

<button
	type="button"
	onclick={copy}
	class="group/cmd flex w-full items-center gap-2.5 rounded-md border border-border bg-surface {pad}
	       transition-colors hover:border-accent/20 hover:bg-surface-raised
	       focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:outline-none"
	aria-label="Copy command: {command}"
>
	<span class="font-mono text-[10px] text-text-dim select-none">$</span>
	<code class="min-w-0 flex-1 truncate text-left font-mono text-text-muted">{command}</code>

	{#if copied}
		<span class="shrink-0 text-[10px] tracking-wide text-positive uppercase">Copied</span>
	{:else if failed}
		<span class="shrink-0 text-[10px] tracking-wide text-warning uppercase">Copy failed</span>
	{:else}
		<svg
			class="h-3.5 w-3.5 shrink-0 text-text-dim transition group-hover/cmd:text-accent"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="2"
			aria-hidden="true"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
			/>
		</svg>
	{/if}
</button>
