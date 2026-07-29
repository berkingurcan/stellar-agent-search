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
		'group relative inline-flex items-center justify-center font-medium tracking-wide transition-all duration-300 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-40';

	const variants: Record<string, string> = {
		primary: 'cta-btn cta-btn--primary text-accent active:scale-[0.98]',
		secondary: 'cta-btn cta-btn--secondary text-accent active:scale-[0.98]',
		ghost: 'text-text-muted hover:text-accent hover:bg-accent/4 active:scale-[0.98]'
	};

	const sizes: Record<string, string> = {
		sm: 'rounded-lg px-3.5 py-[5px] text-[11px] gap-1.5',
		md: 'rounded-lg px-5 py-2.5 text-[12px] gap-2',
		lg: 'rounded-lg px-7 py-3 text-[13px] gap-2.5'
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
		overflow: visible;
	}

	/* -- Primary: opaque accent fill + glow -- */
	.cta-btn--primary {
		background: var(--color-accent-fill);
		border: 0.5px solid color-mix(in oklch, var(--color-accent) 35%, transparent);
		box-shadow: var(--shadow-accent-sm);
	}
	.cta-btn--primary:hover {
		background: var(--color-accent-fill-hover);
		border-color: color-mix(in oklch, var(--color-accent) 55%, transparent);
		box-shadow: var(--shadow-accent-md);
	}

	/* -- Secondary: border only, no fill -- */
	.cta-btn--secondary {
		background: var(--color-surface);
		border: 0.5px solid color-mix(in oklch, var(--color-accent) 22%, transparent);
	}
	.cta-btn--secondary:hover {
		background: var(--color-surface-raised);
		border-color: color-mix(in oklch, var(--color-accent) 35%, transparent);
	}
</style>
