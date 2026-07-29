<script lang="ts">
	import { onMount } from 'svelte';

	const browser = typeof window !== 'undefined';

	let svg: SVGSVGElement = $state() as SVGSVGElement;
	let raf = 0;
	let mouse = { x: -9999, y: -9999 };
	let smooth = { x: -9999, y: -9999 };
	const GLOW = 160;
	const GLOW_SQ = GLOW * GLOW;
	const LERP = 0.08;

	const COLS = 6;
	const ROWS = 6;
	const TILE = 52;
	const ISO_X = 0.866;
	const ISO_Y = 0.5;

	type Node = { id: number; ix: number; iy: number; sx: number; sy: number; r: number; el: SVGCircleElement | null; baseOpacity: number };
	type Edge = { a: Node; b: Node; el: SVGLineElement | null };

	let nodes: Node[] = [];
	let edges: Edge[] = [];

	function isoX(col: number, row: number) {
		return (col - row) * TILE * ISO_X;
	}
	function isoY(col: number, row: number) {
		return (col + row) * TILE * ISO_Y;
	}

	function build() {
		nodes = [];
		edges = [];
		let id = 0;
		for (let row = 0; row < ROWS; row++) {
			for (let col = 0; col < COLS; col++) {
				const r = 1.5 + Math.random() * 2;
				nodes.push({
					id: id++,
					ix: col,
					iy: row,
					sx: isoX(col, row),
					sy: isoY(col, row),
					r,
					el: null,
					baseOpacity: 0.08 + Math.random() * 0.06
				});
			}
		}
		for (let i = 0; i < nodes.length; i++) {
			const n = nodes[i];
			const right = nodes.find((m) => m.ix === n.ix + 1 && m.iy === n.iy);
			const down = nodes.find((m) => m.ix === n.ix && m.iy === n.iy + 1);
			if (right) edges.push({ a: n, b: right, el: null });
			if (down) edges.push({ a: n, b: down, el: null });
		}
	}

	function tick() {
		const dx = mouse.x - smooth.x;
		const dy = mouse.y - smooth.y;
		if (dx * dx + dy * dy > 0.5) {
			smooth.x += dx * LERP;
			smooth.y += dy * LERP;
		}

		for (const node of nodes) {
			if (!node.el) continue;
			const rect = svg.getBoundingClientRect();
			const cx = rect.left + rect.width / 2 + node.sx;
			const cy = rect.top + rect.height / 2 + node.sy;
			const ddx = cx - smooth.x;
			const ddy = cy - smooth.y;
			const distSq = ddx * ddx + ddy * ddy;

			if (distSq < GLOW_SQ) {
				const prox = 1 - Math.sqrt(distSq) / GLOW;
				const opacity = node.baseOpacity + prox * 0.5;
				node.el.setAttribute('opacity', String(opacity));
				node.el.setAttribute('r', String(node.r + prox * 1.5));
			} else {
				node.el.setAttribute('opacity', String(node.baseOpacity));
				node.el.setAttribute('r', String(node.r));
			}
		}

		for (const edge of edges) {
			if (!edge.el) continue;
			const ax = edge.a.sx;
			const ay = edge.a.sy;
			const bx = edge.b.sx;
			const by = edge.b.sy;
			const mx = (ax + bx) / 2;
			const my = (ay + by) / 2;
			const rect = svg.getBoundingClientRect();
			const cx = rect.left + rect.width / 2 + mx;
			const cy = rect.top + rect.height / 2 + my;
			const ddx = cx - smooth.x;
			const ddy = cy - smooth.y;
			const distSq = ddx * ddx + ddy * ddy;

			if (distSq < GLOW_SQ) {
				const prox = 1 - Math.sqrt(distSq) / GLOW;
				edge.el.setAttribute('opacity', String(0.04 + prox * 0.2));
				edge.el.setAttribute('stroke-width', String(0.5 + prox * 0.8));
			} else {
				edge.el.setAttribute('opacity', '0.04');
				edge.el.setAttribute('stroke-width', '0.5');
			}
		}

		raf = requestAnimationFrame(tick);
	}

	function onMove(e: MouseEvent) {
		mouse.x = e.clientX;
		mouse.y = e.clientY;
	}

	onMount(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		build();
		// Assign element refs after render
		nodes = nodes.map((n, i) => ({ ...n, el: svg.querySelector(`[data-node="${i}"]`) }));
		edges = edges.map((e, i) => ({ ...e, el: svg.querySelector(`[data-edge="${i}"]`) }));
		window.addEventListener('mousemove', onMove, { passive: true });
		raf = requestAnimationFrame(tick);
		return () => {
			window.removeEventListener('mousemove', onMove);
			cancelAnimationFrame(raf);
		};
	});

	// Pre-build for SSR
	build();
</script>

{#if browser}
	<svg
		bind:this={svg}
		class="pointer-events-none absolute inset-0 h-full w-full"
		viewBox="-200 -120 400 240"
		preserveAspectRatio="xMidYMid slice"
		aria-hidden="true"
		style="opacity: 0.6;"
	>
		<g transform="translate(0, -20)">
			{#each edges as edge, i (i)}
				<line
					data-edge={i}
					x1={edge.a.sx}
					y1={edge.a.sy}
					x2={edge.b.sx}
					y2={edge.b.sy}
					stroke="var(--color-text-dim)"
					stroke-width="0.5"
					opacity="0.04"
				/>
			{/each}
			{#each nodes as node, i (i)}
				<circle
					data-node={i}
					cx={node.sx}
					cy={node.sy}
					r={node.r}
					fill="var(--color-text-dim)"
					opacity={node.baseOpacity}
				/>
			{/each}
		</g>
	</svg>
{/if}
