<script lang="ts">
	import { onMount } from 'svelte';

	let svg = $state<SVGSVGElement>();
	let raf = 0;
	let mouse = { x: -9999, y: -9999 };
	let smooth = { x: -9999, y: -9999 };
	let hasMouse = false;
	let time = 0;

	const GLOW = 180;
	const GLOW_SQ = GLOW * GLOW;
	const LERP = 0.05;
	const TILE = 60;
	const ISO_X = 0.866;
	const ISO_Y = 0.5;
	const COLS = 5;
	const ROWS = 5;

	type N = { sx: number; sy: number; r: number; phase: number; el: SVGCircleElement | null };
	type E = { a: N; b: N; el: SVGLineElement | null };

	function ix(c: number, r: number) { return (c - r) * TILE * ISO_X; }
	function iy(c: number, r: number) { return (c + r) * TILE * ISO_Y; }

	function build() {
		const nodes: N[] = [];
		const edges: E[] = [];
		for (let r = 0; r < ROWS; r++) {
			for (let c = 0; c < COLS; c++) {
				nodes.push({
					sx: ix(c, r), sy: iy(c, r),
					r: 1.5 + ((c * 17 + r * 31) % 7) * 0.2,
					phase: ((c * 13 + r * 23) % 100) / 100 * Math.PI * 2,
					el: null
				});
			}
		}
		for (let r = 0; r < ROWS; r++) {
			for (let c = 0; c < COLS; c++) {
				const i = r * COLS + c;
				if (c < COLS - 1) edges.push({ a: nodes[i], b: nodes[i + 1], el: null });
				if (r < ROWS - 1) edges.push({ a: nodes[i], b: nodes[i + COLS], el: null });
			}
		}
		return { nodes, edges };
	}

	const { nodes, edges } = build();

	function tick() {
		if (!svg) { raf = 0; return; }
		const rect = svg.getBoundingClientRect();
		const cx0 = rect.left + rect.width / 2;
		const cy0 = rect.top + rect.height / 2;
		const t = time * 0.001;

		const dx = mouse.x - smooth.x;
		const dy = mouse.y - smooth.y;
		if (dx * dx + dy * dy > 0.5) { smooth.x += dx * LERP; smooth.y += dy * LERP; }

		for (const n of nodes) {
			if (!n.el) continue;
			const px = cx0 + n.sx;
			const py = cy0 + n.sy;
			const br = 0.8 + 0.2 * Math.sin(t * 0.6 + n.phase);
			if (hasMouse) {
				const ddx = px - smooth.x, ddy = py - smooth.y;
				const ds = ddx * ddx + ddy * ddy;
				if (ds < GLOW_SQ) {
					const p = 1 - Math.sqrt(ds) / GLOW;
					n.el.setAttribute('opacity', String((0.1 + p * p * 0.5) * br));
					n.el.setAttribute('r', String(n.r + p * p * 2));
				} else {
					n.el.setAttribute('opacity', String(0.1 * br));
					n.el.setAttribute('r', String(n.r));
				}
			} else {
				n.el.setAttribute('opacity', String(0.1 * br));
				n.el.setAttribute('r', String(n.r));
			}
		}

		for (const e of edges) {
			if (!e.el) continue;
			const mx = (e.a.sx + e.b.sx) / 2;
			const my = (e.a.sy + e.b.sy) / 2;
			const br = 0.6 + 0.4 * Math.sin(t * 0.4 + e.a.phase);
			if (hasMouse) {
				const ddx = cx0 + mx - smooth.x, ddy = cy0 + my - smooth.y;
				const ds = ddx * ddx + ddy * ddy;
				if (ds < GLOW_SQ) {
					const p = 1 - Math.sqrt(ds) / GLOW;
					e.el.setAttribute('opacity', String((0.06 + p * 0.25) * br));
				} else {
					e.el.setAttribute('opacity', String(0.06 * br));
				}
			} else {
				e.el.setAttribute('opacity', String(0.06 * br));
			}
		}

		time += 16;
		raf = requestAnimationFrame(tick);
	}

	onMount(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		if (!svg) return;
		for (let i = 0; i < nodes.length; i++) nodes[i].el = svg.querySelector(`[data-n="${i}"]`);
		for (let i = 0; i < edges.length; i++) edges[i].el = svg.querySelector(`[data-e="${i}"]`);
		const onM = (e: MouseEvent) => { mouse.x = e.clientX; mouse.y = e.clientY; hasMouse = true; };
		const onT = (e: TouchEvent) => { if (e.touches.length) { mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; hasMouse = true; } };
		const onL = () => { hasMouse = false; };
		window.addEventListener('mousemove', onM, { passive: true });
		window.addEventListener('touchmove', onT, { passive: true });
		window.addEventListener('touchend', onL, { passive: true });
		raf = requestAnimationFrame(tick);
		return () => { window.removeEventListener('mousemove', onM); window.removeEventListener('touchmove', onT); window.removeEventListener('touchend', onL); cancelAnimationFrame(raf); };
	});
</script>

<svg bind:this={svg} class="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox="-200 -140 400 280" preserveAspectRatio="xMidYMid slice" aria-hidden="true" style="opacity:0.6">
	<g transform="translate(0,-20)">
		{#each edges as e, i (i)}
			<line data-e={i} x1={e.a.sx} y1={e.a.sy} x2={e.b.sx} y2={e.b.sy} stroke="var(--color-text-dim)" stroke-width="0.5" opacity="0.06" />
		{/each}
		{#each nodes as n, i (i)}
			<circle data-n={i} cx={n.sx} cy={n.sy} r={n.r} fill="var(--color-text-dim)" opacity="0.1" />
		{/each}
	</g>
</svg>
