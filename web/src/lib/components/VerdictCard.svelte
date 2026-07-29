<script lang="ts">
	import { SAMPLE } from '$lib/transcripts.js';
</script>

<figure class="m-0 border-y border-border py-8 sm:py-10">
	<div class="grid grid-cols-[1fr_auto_1fr] gap-4 sm:gap-10">
		<div class="space-y-2 sm:space-y-3">
			<p class="text-[10px] tracking-[0.18em] text-text-dim uppercase">Declared</p>
			<p class="text-[2rem] leading-none font-light tabular-nums text-text sm:text-[3.5rem]">
				{SAMPLE.declared}
			</p>
			<p class="text-[11px] text-text-dim">{SAMPLE.declaredSource}</p>
		</div>

		<div class="w-px bg-border"></div>

		<div class="space-y-2 sm:space-y-3">
			<p class="text-[10px] tracking-[0.18em] text-text-dim uppercase">On-chain</p>
			<p class="text-[1.5rem] leading-none font-light text-text sm:text-[2.4rem]">{SAMPLE.onchain}</p>
			<p class="text-[11px] text-text-dim">{SAMPLE.onchainSource}</p>
		</div>
	</div>
</figure>
