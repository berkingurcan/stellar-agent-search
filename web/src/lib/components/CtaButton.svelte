<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		href = undefined,
		onclick = undefined,
		variant = 'primary',
		size = 'md',
		disabled = false,
		full = false,
		external = false,
		children
	}: {
		href?: string;
		onclick?: () => void;
		variant?: 'primary' | 'secondary' | 'ghost';
		size?: 'sm' | 'md' | 'lg';
		disabled?: boolean;
		full?: boolean;
		external?: boolean;
		children: Snippet;
	} = $props();

	const base =
		'group relative inline-flex items-center justify-center font-medium tracking-wide transition-all duration-200 [transition-timing-function:var(--ease-standard)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-40';

	const variants: Record<string, string> = {
		primary: 'cta-btn cta-btn--primary active:scale-[0.98]',
		secondary: 'cta-btn cta-btn--secondary active:scale-[0.98]',
		ghost: 'text-text-muted hover:text-text active:scale-[0.98]'
	};

	const sizes: Record<string, string> = {
		sm: 'rounded-md px-3.5 py-[5px] text-[11px] gap-1.5',
		md: 'rounded-md px-5 py-2.5 text-[12px] gap-2',
		lg: 'rounded-md px-7 py-3 text-[13px] gap-2.5'
	};

	const classes = $derived(
		`${base} ${variants[variant]} ${sizes[size]} ${full ? 'w-full' : ''}`
	);
</script>

{#if href}
	<a
		{href}
		class={classes}
		target={external ? '_blank' : undefined}
		rel={external ? 'noopener noreferrer' : undefined}
	>
		{@render children()}
	</a>
{:else}
	<button {onclick} {disabled} class={classes}>
		{@render children()}
	</button>
{/if}

<style>
	.cta-btn {
		position: relative;
	}

	.cta-btn--primary {
		background: var(--color-text);
		color: var(--color-surface);
		border: 1px solid var(--color-text);
	}
	.cta-btn--primary:hover {
		opacity: 0.85;
	}

	.cta-btn--secondary {
		background: transparent;
		border: 1px solid var(--color-border);
		color: var(--color-text-muted);
	}
	.cta-btn--secondary:hover {
		border-color: var(--color-text);
		color: var(--color-text);
	}
</style>
