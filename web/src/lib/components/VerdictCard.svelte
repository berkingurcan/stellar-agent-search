<script lang="ts">
	import { SAMPLE, CAPTURED_ON } from '$lib/transcripts.js';
</script>

<figure class="m-0 border-y border-border py-10">
	<div class="grid grid-cols-1 gap-8 sm:grid-cols-[1fr_1px_1fr] sm:gap-10">
		<div class="space-y-3">
			<p class="font-mono text-[10px] tracking-[0.18em] text-text-dim uppercase">Declared</p>
			<p class="text-[3rem] leading-none font-light tabular-nums text-text sm:text-[3.5rem]">
				{SAMPLE.declared}
			</p>
			<p class="font-mono text-[11px] text-text-dim">{SAMPLE.declaredSource}</p>
		</div>

		<div class="hidden bg-border sm:block"></div>

		<div class="space-y-3">
			<p class="font-mono text-[10px] tracking-[0.18em] text-text-dim uppercase">Contract probe</p>
			<p class="text-[2rem] leading-none font-light text-text sm:text-[2.4rem]">{SAMPLE.onchain}</p>
			<p class="font-mono text-[11px] text-text-dim">{SAMPLE.onchainSource}</p>
		</div>
	</div>

	<figcaption class="mt-8 text-[12.5px] leading-relaxed text-text-dim">
		Agent #{SAMPLE.agentId} &middot; {SAMPLE.name} (self-declared) &middot; verified fields:
		{SAMPLE.verifiedFields} &middot; {SAMPLE.note}
	</figcaption>
</figure>
