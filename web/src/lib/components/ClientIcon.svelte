<script lang="ts">
	import { CLIENT_LOGOS } from '$lib/client-logos.js';

	/**
	 * Official client brand marks (see client-logos.ts for sources), tinted with
	 * currentColor so the row inherits the page's text colors. Unknown ids fall
	 * back to a neutral terminal glyph.
	 */
	let { id, class: className = 'h-4 w-4' }: { id: string; class?: string } = $props();

	const logo = $derived(CLIENT_LOGOS[id]);
</script>

{#if logo}
	<svg class={className} viewBox={logo.viewBox} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
		{#each logo.paths as p (p.d)}
			{#if p.stroke}
				<path
					d={p.d}
					fill="none"
					stroke="currentColor"
					stroke-width={p.strokeWidth ?? 2}
					stroke-linecap="round"
				/>
			{:else}
				<path d={p.d} fill="currentColor" fill-rule="evenodd" />
			{/if}
		{/each}
	</svg>
{:else}
	<svg
		class={className}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.6"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<rect x="3" y="4.5" width="18" height="15" rx="2" />
		<path d="M7 9.5l3 2.75L7 15M12.5 15.5H17" />
	</svg>
{/if}
