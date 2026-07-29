<script lang="ts">
	import { SAMPLE } from '$lib/transcripts.js';
</script>

<figure class="m-0 border-y border-border py-8 sm:py-10">
	<div class="grid grid-cols-1 gap-6 sm:grid-cols-[1fr_1px_1fr] sm:gap-10">
		<div class="space-y-2 sm:space-y-3">
			<p class="text-[10px] tracking-[0.18em] text-text-dim uppercase">
				<span
					class="tip"
					role="button"
					tabindex="0"
					data-tooltip="The reputation figure as reported by the Explorer indexer — self-declared by the agent's owner, not yet checked against the chain."
					aria-label="Declared — the reputation figure from the Explorer; self-declared, not checked.">Declared</span
				>
			</p>
			<p class="text-[2.25rem] leading-none font-light tabular-nums text-text sm:text-[3.5rem]">
				{SAMPLE.declared}
			</p>
			<p class="text-[11px] text-text-dim">
				<span
					class="tip"
					role="button"
					tabindex="0"
					data-tooltip="The stellar8004.com indexer that aggregates agent metadata and declared reputation."
					aria-label="explorer indexer — the stellar8004.com indexer.">{SAMPLE.declaredSource}</span
				>
			</p>
		</div>

		<div class="hidden bg-border sm:block"></div>

		<div class="space-y-2 sm:space-y-3">
			<p class="text-[10px] tracking-[0.18em] text-text-dim uppercase">
				<span
					class="tip"
					role="button"
					tabindex="0"
					data-tooltip="A single bounded read of the on-chain Reputation contract. 'Reachable' means it answered — not that declared fields were verified."
					aria-label="Contract probe — a bounded read of the Reputation contract; 'reachable' means it answered.">Contract probe</span
				>
			</p>
			<p class="text-[1.5rem] leading-none font-light text-text sm:text-[2.4rem]">{SAMPLE.onchain}</p>
			<p class="text-[11px] text-text-dim">{SAMPLE.onchainSource}</p>
		</div>
	</div>

	<figcaption class="mt-8 text-[12.5px] leading-relaxed text-text-dim">
		Agent #{SAMPLE.agentId} · {SAMPLE.name} (
		<span
			class="tip"
			role="button"
			tabindex="0"
			data-tooltip="Data the agent's owner published about their own agent. Unverified by default."
			aria-label="self-declared — data published by the owner; unverified.">self-declared</span
		>) · verified fields:
		<span
			class="tip"
			role="button"
			tabindex="0"
			data-tooltip="The reputation fields authoritatively confirmed against the contract. Empty unless the read covers every declared field."
			aria-label="verified fields — fields confirmed against the contract; empty unless fully covered.">{SAMPLE.verifiedFields}</span
		> · {SAMPLE.note}
	</figcaption>
</figure>
