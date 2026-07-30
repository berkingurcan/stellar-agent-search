<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import CtaButton from '$lib/components/CtaButton.svelte';
</script>

<svelte:head><title>{page.status} · stellar-agent-search</title></svelte:head>

<div class="flex min-h-[50vh] flex-col items-start justify-center gap-6">
	<p class="font-mono text-[11px] tracking-[0.25em] text-text-dim uppercase">
		Error {page.status}
	</p>
	<h1 class="text-3xl font-light tracking-tight text-text">
		{page.error?.message ?? 'Something went wrong'}
	</h1>
	<p class="max-w-md text-[15px] leading-relaxed font-light text-text-muted">
		This site is a single page. If you followed a link here, it was probably to a section anchor
		that no longer exists.
	</p>
	<CtaButton href="{base}/" size="md">Back to the landing page</CtaButton>
</div>
