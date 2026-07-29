<script lang="ts">
	import { SAMPLE } from '$lib/transcripts.js';
</script>

<div class="grid grid-cols-2 gap-px border-y border-border">
	<div class="py-8 sm:py-10">
		<p class="text-[10px] tracking-[0.18em] text-text-dim uppercase">Declared</p>
		<p class="mt-3 text-[2rem] leading-none font-light tabular-nums text-text sm:text-[3.5rem]">{SAMPLE.declared}</p>
		<p class="mt-2 text-[11px] text-text-dim">{SAMPLE.declaredSource}</p>
	</div>
	<div class="border-l border-border py-8 pl-4 sm:py-10 sm:pl-10">
		<p class="text-[10px] tracking-[0.18em] text-text-dim uppercase">On-chain</p>
		<p class="mt-3 text-[1.5rem] leading-none font-light text-text sm:text-[2.4rem]">{SAMPLE.onchain}</p>
		<p class="mt-2 text-[11px] text-text-dim">{SAMPLE.onchainSource}</p>
	</div>
</div>
