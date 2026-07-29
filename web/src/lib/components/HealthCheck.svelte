<script lang="ts">
	import { reveal } from '$lib/actions/reveal.js';
	import { TOOL_COUNT } from '$lib/surface.js';

	const checks = [
		{ label: 'Node', value: 'v26.4.0', ok: true },
		{ label: 'Network', value: 'mainnet', ok: true },
		{ label: 'Read-only', value: 'keyless', ok: true },
		{ label: 'Explorer', value: 'healthy', ok: true },
		{ label: 'Soroban RPC', value: 'healthy', ok: true },
		{ label: 'Contract', value: 'readable', ok: true },
		{ label: 'Tools', value: `${TOOL_COUNT} loaded`, ok: true }
	];
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between border-b border-border-subtle pb-3">
		<span class="text-[11px] tracking-[0.15em] text-text-dim uppercase">Health check</span>
		<span class="text-[11px] text-text-dim">doctor · self-check</span>
	</div>

	<div
		class="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4"
		use:reveal
	>
		{#each checks as check (check.label)}
			<div class="bg-surface p-3 space-y-1.5 sm:p-4 sm:space-y-2">
				<div class="flex items-center gap-2">
					<svg
						class="h-3.5 w-3.5 text-positive"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M20 6L9 17l-5-5" />
					</svg>
					<span class="text-[12px] font-medium text-text">{check.label}</span>
				</div>
				<p class="text-[11px] text-text-dim">{check.value}</p>
			</div>
		{/each}
	</div>

	<p class="pt-1 text-[11px] text-text-dim">
		No signer, no writes — the keyless invariant is enforced in CI
	</p>
</div>
