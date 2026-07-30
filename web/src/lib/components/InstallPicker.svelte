<script lang="ts">
	import ClientIcon from './ClientIcon.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import type { InstallConfig } from '$lib/install-types.js';

	let { configs }: { configs: InstallConfig[] } = $props();

	let selected = $state<string | null>(null);
	const active = $derived(selected ?? configs[0]?.id ?? '');
	let copied = $state('');
	let failed = $state('');
	let timer: ReturnType<typeof setTimeout>;

	async function copy(cfg: InstallConfig) {
		clearTimeout(timer);
		try {
			await navigator.clipboard.writeText(cfg.code);
			copied = cfg.id;
			failed = '';
		} catch {
			// Clipboard needs a secure context; report the miss instead of faking a checkmark.
			failed = cfg.id;
			copied = '';
		}
		timer = setTimeout(() => {
			copied = '';
			failed = '';
		}, 1800);
	}
</script>

<div class="space-y-5">
	<div role="tablist" aria-label="MCP clients" class="flex flex-wrap gap-2">
		{#each configs as cfg (cfg.id)}
			<button
				type="button"
				role="tab"
				id="tab-{cfg.id}"
				aria-selected={active === cfg.id}
				aria-controls="panel-{cfg.id}"
				onclick={() => (selected = cfg.id)}
				class="flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12px] transition-colors
				       focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:outline-none
				       {active === cfg.id
					? 'border-accent/30 bg-accent-medium text-text'
					: 'border-border text-text-muted hover:border-accent/20 hover:text-text'}"
			>
				<ClientIcon id={cfg.id} class="h-3.5 w-3.5 {active === cfg.id ? 'text-text' : 'text-text-dim'}" />
				{cfg.label}
			</button>
		{/each}
	</div>

	<!-- Every panel stays in the DOM (inactive ones carry `hidden`) so the
	     prerendered HTML keeps one data-install-config marker per client for
	     the release-surface gate. -->
	{#each configs as cfg (cfg.id)}
		<div
			role="tabpanel"
			id="panel-{cfg.id}"
			aria-labelledby="tab-{cfg.id}"
			data-install-config={cfg.id}
			hidden={active !== cfg.id}
			class="space-y-2.5"
		>
			<div class="flex items-start justify-between gap-4">
				<p class="text-[12.5px] leading-relaxed text-text-muted">{cfg.tagline}</p>
				<button
					type="button"
					onclick={() => copy(cfg)}
					class="shrink-0 rounded-md border border-border px-2.5 py-1 text-[10.5px] tracking-wide uppercase
					       transition-colors focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:outline-none
					       {copied === cfg.id
						? 'border-positive/40 text-positive'
						: failed === cfg.id
							? 'text-text-dim'
							: 'text-text-dim hover:border-accent/20 hover:text-text-muted'}"
					aria-label="Copy {cfg.label} install snippet"
				>
					{copied === cfg.id ? 'Copied' : failed === cfg.id ? 'Copy failed' : 'Copy'}
				</button>
			</div>
			<CodeBlock code={cfg.code} lang={cfg.lang} class="text-[12px]" />
			{#if cfg.note}
				<p class="max-w-2xl text-[11px] leading-relaxed text-text-dim">{cfg.note}</p>
			{/if}
		</div>
	{/each}
</div>
