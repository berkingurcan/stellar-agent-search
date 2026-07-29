<script lang="ts">
	import { onMount } from 'svelte';

	// Read straight from the browser. The upstream rate-limits per client address
	// (30/min; its Cloudflare adapter derives that address from cf-connecting-ip)
	// and already sends
	// `access-control-allow-origin: *` plus a 30s cache header — so fetching here
	// gives every visitor their own budget, and proxying would give them all one.
	const STATS_URL = 'https://stellar8004.com/api/v1/stats';
	const EXPLORER_AGENTS = 'https://stellar8004.com/agents';

	// These are the indexer's own aggregates, and the strip says so. An earlier
	// version showed "N take payment" from `agentsWithX402 + agentsWithMpp`, which
	// reported 4 while `stellar-agent-mcp services --x402` finds 2 declared x402
	// agents (issues/P2-08 documents the same gap). Publishing an unverified
	// aggregate as fact, on this page, argued against the page.
	let agents = $state<number | null>(null);
	let reviews = $state<number | null>(null);
	let clients = $state<number | null>(null);
	let failed = $state(false);

	const nf = new Intl.NumberFormat('en-US');
	const show = (n: number | null) => (n === null ? '—' : nf.format(n));

	onMount(async () => {
		try {
			const res = await fetch(STATS_URL);
			if (!res.ok) throw new Error(String(res.status));
			const body = await res.json();
			if (!body?.success) throw new Error('api');
			agents = body.data.totalAgents ?? null;
			reviews = body.data.totalFeedbacks ?? null;
			clients = body.data.totalUniqueClients ?? null;
		} catch {
			// An em dash, never a placeholder number.
			failed = true;
		}
	});
</script>

<div class="rounded-xl border border-border bg-surface-raised px-5 py-4">
	<div class="flex flex-wrap items-baseline gap-x-8 gap-y-2">
		<span class="font-mono text-[10px] tracking-[0.15em] text-text-dim uppercase">
			{failed ? 'Explorer unreachable' : 'Registry, as the explorer reports it'}
		</span>

		<span class="text-[13px] text-text-muted">
			<span class="tabular-nums text-text">{show(agents)}</span> agents
		</span>
		<span class="text-[13px] text-text-muted">
			<span class="tabular-nums text-text">{show(reviews)}</span> reviews
		</span>
		<span class="text-[13px] text-text-muted">
			<span class="tabular-nums text-text">{show(clients)}</span> unique clients
		</span>

		<a
			href={EXPLORER_AGENTS}
			target="_blank"
			rel="noopener noreferrer"
			class="ml-auto text-[11px] text-text-dim transition hover:text-accent"
		>
			Browse them &rarr;
		</a>
	</div>

	<p class="mt-2.5 text-[11px] text-text-dim">
		Indexer totals, self-reported and not re-derived &mdash; the same kind of figure this server
		exists to check.
	</p>
</div>
