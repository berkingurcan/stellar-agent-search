<script lang="ts">
	import { onMount } from 'svelte';

	let svg = $state<SVGSVGElement>();
	let raf = 0;
	let mouse = { x: -9999, y: -9999 };
	let smooth = { x: -9999, y: -9999 };
	const GLOW = 180;
	const GLOW_SQ = GLOW * GLOW;
	const LERP = 0.08;

	const COLS = 7;
	const ROWS = 7;
	const TILE = 48;
	const ISO_X = 0.866;
	const ISO_Y = 0.5;

	type Node = {
		ix: number;
		iy: number;
		sx: number;
		sy: number;
		r: number;
		el: SVGCircleElement | null;
		baseOpacity: number;
	};
	type Edge = { a: Node; b: Node; el: SVGLineElement | null };

	function isoX(col: number, row: number) {
		return (col - row) * TILE * ISO_X;
	}
	function isoY(col: number, row: number) {
		return (col + row) * TILE * ISO_Y;
	}

	function build() {
		const builtNodes: Node[] = [];
		const builtEdges: Edge[] = [];
		for (let row = 0; row < ROWS; row++) {
			for (let col = 0; col < COLS; col++) {
				// Keep SSR and hydration byte-stable. Math.random() here makes the
				// server and browser render different SVG attributes.
				const radiusStep = (col * 17 + row * 31) % 11;
				const opacityStep = (col * 7 + row * 11) % 5;
				builtNodes.push({
					ix: col,
					iy: row,
					sx: isoX(col, row),
					sy: isoY(col, row),
					r: 1.8 + radiusStep * 0.2,
					el: null,
					baseOpacity: 0.12 + opacityStep * 0.02
				});
			}
		}
		for (let i = 0; i < builtNodes.length; i++) {
			const n = builtNodes[i];
			const right = builtNodes.find((m) => m.ix === n.ix + 1 && m.iy === n.iy);
			const down = builtNodes.find((m) => m.ix === n.ix && m.iy === n.iy + 1);
			if (right) builtEdges.push({ a: n, b: right, el: null });
			if (down) builtEdges.push({ a: n, b: down, el: null });
		}

		return { nodes: builtNodes, edges: builtEdges };
	}

	// Pre-build deterministically so SSR and hydration emit identical SVG.
	const { nodes, edges } = build();

	function tick() {
		if (!svg) {
			raf = 0;
			return;
		}

		const dx = mouse.x - smooth.x;
		const dy = mouse.y - smooth.y;
		const moving = dx * dx + dy * dy > 0.5;
		if (moving) {
			smooth.x += dx * LERP;
			smooth.y += dy * LERP;
		}
		const rect = svg.getBoundingClientRect();

		for (const node of nodes) {
			if (!node.el) continue;
			const cx = rect.left + rect.width / 2 + node.sx;
			const cy = rect.top + rect.height / 2 + node.sy;
			const ddx = cx - smooth.x;
			const ddy = cy - smooth.y;
			const distSq = ddx * ddx + ddy * ddy;

			if (distSq < GLOW_SQ) {
				const prox = 1 - Math.sqrt(distSq) / GLOW;
				node.el.setAttribute('opacity', String(node.baseOpacity + prox * 0.6));
				node.el.setAttribute('r', String(node.r + prox * 2));
			} else {
				node.el.setAttribute('opacity', String(node.baseOpacity));
				node.el.setAttribute('r', String(node.r));
			}
		}

		for (const edge of edges) {
			if (!edge.el) continue;
			const mx = (edge.a.sx + edge.b.sx) / 2;
			const my = (edge.a.sy + edge.b.sy) / 2;
			const cx = rect.left + rect.width / 2 + mx;
			const cy = rect.top + rect.height / 2 + my;
			const ddx = cx - smooth.x;
			const ddy = cy - smooth.y;
			const distSq = ddx * ddx + ddy * ddy;

			if (distSq < GLOW_SQ) {
				const prox = 1 - Math.sqrt(distSq) / GLOW;
				edge.el.setAttribute('opacity', String(0.08 + prox * 0.3));
				edge.el.setAttribute('stroke-width', String(0.6 + prox * 1));
			} else {
				edge.el.setAttribute('opacity', '0.08');
				edge.el.setAttribute('stroke-width', '0.6');
			}
		}

		raf = moving ? requestAnimationFrame(tick) : 0;
	}

	function onMove(e: MouseEvent) {
		mouse.x = e.clientX;
		mouse.y = e.clientY;
		if (raf === 0) raf = requestAnimationFrame(tick);
	}

	onMount(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		if (!svg) return;

		// These refs are animation-only state; mutating them avoids a redundant
		// template update after hydration.
		for (let i = 0; i < nodes.length; i++) {
			nodes[i].el = svg.querySelector(`[data-node="${i}"]`);
		}
		for (let i = 0; i < edges.length; i++) {
			edges[i].el = svg.querySelector(`[data-edge="${i}"]`);
		}

		window.addEventListener('mousemove', onMove, { passive: true });

		return () => {
			window.removeEventListener('mousemove', onMove);
			cancelAnimationFrame(raf);
		};
	});
</script>

<svg
	bind:this={svg}
	class="pointer-events-none absolute inset-0 h-full w-full"
	viewBox="-260 -160 520 320"
	preserveAspectRatio="xMidYMid slice"
	aria-hidden="true"
	style="opacity: 0.7;"
>
	<g transform="translate(0, -30)">
		{#each edges as edge, i (i)}
			<line
				data-edge={i}
				x1={edge.a.sx}
				y1={edge.a.sy}
				x2={edge.b.sx}
				y2={edge.b.sy}
				stroke="var(--color-text-dim)"
				stroke-width="0.6"
				opacity="0.08"
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
