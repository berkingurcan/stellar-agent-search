<script lang="ts">
	// The hero artifact: one real declared-vs-verified diff, rendered as a
	// designed object. This is the product in one glance — solid surface,
	// hairline borders, large tabular numbers. No glass, no glow.
	import { SAMPLE, CAPTURED_ON } from '$lib/transcripts.js';
</script>

<figure class="m-0 overflow-hidden rounded-xl border border-border bg-surface-raised">
	<!-- Status bar -->
	<div class="flex items-center justify-between border-b border-border-subtle px-6 py-3">
		<div class="flex items-center gap-2">
			<span class="h-1.5 w-1.5 rounded-full bg-accent"></span>
			<span class="font-mono text-[11px] tracking-[0.15em] text-accent uppercase"
				>{SAMPLE.status}</span
			>
		</div>
		<span class="font-mono text-[10px] text-text-dim">checked {CAPTURED_ON}</span>
	</div>

	<!-- Agent identity -->
	<div class="border-b border-border-subtle px-6 py-3.5">
		<div class="flex items-baseline gap-2.5">
			<span class="font-mono text-[12px] text-text-dim">#{SAMPLE.agentId}</span>
			<span class="text-[14px] font-medium text-text">{SAMPLE.name}</span>
			<span class="font-mono text-[10px] tracking-wide text-text-dim uppercase">self-declared</span>
		</div>
	</div>

	<!-- The comparison — two readings of the same number, side by side -->
	<div class="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 py-8">
		<div>
			<p class="font-mono text-[10px] tracking-[0.15em] text-text-dim uppercase">Declared</p>
			<p class="mt-2 text-[2.5rem] leading-none font-light tabular-nums text-text-muted sm:text-[3rem]">
				{SAMPLE.declared}
			</p>
			<p class="mt-2 font-mono text-[10.5px] text-text-dim">{SAMPLE.declaredSource}</p>
		</div>

		<div class="flex h-full items-center">
			<span class="font-mono text-[10px] text-text-dim">vs</span>
		</div>

		<div>
			<p class="font-mono text-[10px] tracking-[0.15em] text-text-dim uppercase">On-chain</p>
			<p class="mt-2 text-[2.5rem] leading-none font-light tabular-nums text-text sm:text-[3rem]">
				{SAMPLE.onchain}
			</p>
			<p class="mt-2 font-mono text-[10.5px] text-accent">{SAMPLE.onchainSource}</p>
		</div>
	</div>

	<!-- Note -->
	<div class="border-t border-border-subtle px-6 py-4">
		<p class="text-[12px] leading-relaxed text-text-dim">{SAMPLE.note}</p>
	</div>

	<!-- Metadata -->
	<div
		class="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border-subtle bg-surface/50 px-6 py-3 font-mono text-[10.5px] text-text-dim"
	>
		<span>
			on-chain <span class="tabular-nums text-text-muted">{SAMPLE.onchainFeedback}</span> reviews
		</span>
		<span>
			ranked <span class="tabular-nums text-text-muted">{SAMPLE.rank}</span>, confidence
			<span class="tabular-nums text-text-muted">{SAMPLE.confidence}</span>
		</span>
	</div>
</figure>
