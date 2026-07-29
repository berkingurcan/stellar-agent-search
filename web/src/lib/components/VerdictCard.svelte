<script lang="ts">
	// The hero artifact: one real declared-vs-verified diff, rendered as a designed
	// object rather than a line of table output. This is the product in one glance,
	// so it sits above the fold — the page claims the server checks things, and this
	// is the check.
	import { SAMPLE, CAPTURED_ON } from '$lib/transcripts.js';
</script>

<figure
	class="glass-card m-0 overflow-hidden rounded-2xl border border-border shadow-accent-sm"
>
	<!-- Verdict band. Colour carries the meaning here, exactly as it does in the CLI. -->
	<figcaption
		class="flex items-center justify-between gap-3 border-b border-accent/20 bg-accent-fill px-5 py-3"
	>
		<span class="flex items-center gap-2">
			<svg
				class="h-3.5 w-3.5 text-accent"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				stroke-width="2.5"
				aria-hidden="true"
			>
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M5.1 19h13.8L12 5 5.1 19z" />
			</svg>
			<span class="font-mono text-[11px] tracking-[0.18em] text-accent uppercase"
				>{SAMPLE.status}</span
			>
		</span>
		<span class="text-[10.5px] text-text-dim">checked {CAPTURED_ON}</span>
	</figcaption>

	<div class="space-y-5 px-5 py-5">
		<div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
			<span class="font-mono text-[12px] text-text-dim">#{SAMPLE.agentId}</span>
			<span class="text-[14px] font-medium text-text">{SAMPLE.name}</span>
			<span class="text-[10px] tracking-wide text-text-dim uppercase">self-declared</span>
		</div>

		<!-- The comparison itself. Two readings of the same number, side by side,
		     with the source of each named — that distinction is the entire product. -->
		<div class="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
			<div>
				<p class="text-[10px] tracking-[0.14em] text-text-dim uppercase">Declared</p>
				<p class="mt-1.5 text-[2rem] leading-none font-light tabular-nums text-text-muted">
					{SAMPLE.declared}
				</p>
				<p class="mt-1.5 text-[10.5px] text-text-dim">{SAMPLE.declaredSource}</p>
			</div>

			<div class="flex h-full flex-col items-center justify-center gap-2 px-1">
				<span class="h-full w-px bg-border"></span>
				<span class="font-mono text-[10px] text-text-dim">vs</span>
				<span class="h-full w-px bg-border"></span>
			</div>

			<div>
				<p class="text-[10px] tracking-[0.14em] text-text-dim uppercase">On-chain</p>
				<p class="mt-1.5 text-[2rem] leading-none font-light tabular-nums text-text">
					{SAMPLE.onchain}
				</p>
				<p class="mt-1.5 text-[10.5px] text-accent">{SAMPLE.onchainSource}</p>
			</div>
		</div>

		<p class="border-l-2 border-border pl-3 text-[11.5px] leading-relaxed text-text-dim">
			{SAMPLE.note}
		</p>
	</div>

	<!-- Count is contract-derived; unique-client coverage is deliberately not. -->
	<div
		class="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border bg-surface-raised/50 px-5 py-3 font-mono text-[10.5px] text-text-dim"
	>
		<span>
			on-chain
			<span class="tabular-nums text-text-muted">{SAMPLE.onchainFeedback}</span> comparable feedback ·
			<span class="text-text-muted">{SAMPLE.onchainClientCoverage}</span>
		</span>
		<span>
			ranked <span class="tabular-nums text-text-muted">{SAMPLE.rank}</span>, confidence
			<span class="tabular-nums text-text-muted">{SAMPLE.confidence}</span>
		</span>
	</div>
</figure>
