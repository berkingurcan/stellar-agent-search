<script lang="ts">
	import ClientIcon from './ClientIcon.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import type { InstallConfig } from '$lib/install-types.js';

	let { configs }: { configs: InstallConfig[] } = $props();

	// Accordion: the first client (Claude Code) starts open.
	let selected = $state<string | null>(null);
	const active = $derived(selected ?? configs[0]?.id ?? '');
	let copied = $state('');
	let failed = $state('');
	let timer: ReturnType<typeof setTimeout>;

	function toggle(id: string) {
		selected = active === id ? '' : id;
	}

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

<!-- Every config stays in the DOM (collapsed bodies carry `hidden`) so the
     prerendered HTML keeps one data-install-config marker per client for the
     release-surface gate. -->
<ul class="divide-y divide-border border-y border-border">
	{#each configs as cfg (cfg.id)}
		<li data-install-config={cfg.id}>
			<button
				type="button"
				id="client-{cfg.id}"
				aria-expanded={active === cfg.id}
				aria-controls="config-{cfg.id}"
				onclick={() => toggle(cfg.id)}
				class="group flex w-full items-center gap-4 py-4 text-left transition-colors focus-visible:ring-1
				       focus-visible:ring-accent/40 focus-visible:outline-none sm:gap-5 sm:py-5"
			>
				<ClientIcon
					id={cfg.id}
					class="h-5 w-5 shrink-0 transition-colors {active === cfg.id
						? 'text-text'
						: 'text-text-dim group-hover:text-text-muted'}"
				/>
				<span class="w-28 shrink-0 text-[14px] font-medium text-text sm:w-32 sm:text-[15px]">
					{cfg.label}
				</span>
				<span class="hidden min-w-0 flex-1 truncate text-[12.5px] text-text-dim sm:block">
					{cfg.tagline}
				</span>
				<svg
					class="h-3.5 w-3.5 shrink-0 text-text-dim transition-transform duration-200 {active === cfg.id
						? 'rotate-180'
						: ''}"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"
				>
					<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
				</svg>
			</button>

			<div
				id="config-{cfg.id}"
				role="region"
				aria-labelledby="client-{cfg.id}"
				hidden={active !== cfg.id}
				class="space-y-2.5 pb-5 sm:pb-6"
			>
				<div class="flex items-start justify-between gap-4 sm:hidden">
					<p class="text-[12px] leading-relaxed text-text-dim">{cfg.tagline}</p>
				</div>
				<div class="relative">
					<CodeBlock code={cfg.code} lang={cfg.lang} class="text-[12px]" />
					<button
						type="button"
						onclick={() => copy(cfg)}
						class="absolute top-2.5 right-2.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[10.5px]
						       tracking-wide uppercase transition-colors focus-visible:ring-1
						       focus-visible:ring-accent/40 focus-visible:outline-none
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
				{#if cfg.note}
					<p class="max-w-2xl text-[11px] leading-relaxed text-text-dim">{cfg.note}</p>
				{/if}
			</div>
		</li>
	{/each}
</ul>
