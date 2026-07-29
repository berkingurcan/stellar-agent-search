<script lang="ts">
	import { onMount } from 'svelte';

	let svg = $state<SVGSVGElement>();
	let raf = 0;
	let mouse = { x: -9999, y: -9999 };
	let smooth = { x: -9999, y: -9999 };
	let hasMouse = false;
	let time = 0;

	const GLOW = 200;
	const GLOW_SQ = GLOW * GLOW;
	const LERP = 0.06;

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
		phase: number;
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
		const n: Node[] = [];
		const e: Edge[] = [];
		for (let row = 0; row < ROWS; row++) {
			for (let col = 0; col < COLS; col++) {
				const radiusStep = (col * 17 + row * 31) % 11;
				const opacityStep = (col * 7 + row * 11) % 5;
				const phaseStep = (col * 13 + row * 23) % 100;
				n.push({
					ix: col,
					iy: row,
					sx: isoX(col, row),
					sy: isoY(col, row),
					r: 2 + radiusStep * 0.25,
					phase: (phaseStep / 100) * Math.PI * 2,
					el: null,
					baseOpacity: 0.15 + opacityStep * 0.02
				});
			}
		}
		for (let i = 0; i < n.length; i++) {
			const node = n[i];
			const right = n.find((m) => m.ix === node.ix + 1 && m.iy === node.iy);
			const down = n.find((m) => m.ix === node.ix && m.iy === node.iy + 1);
			if (right) e.push({ a: node, b: right, el: null });
			if (down) e.push({ a: node, b: down, el: null });
		}
		return { nodes: n, edges: e };
	}

	const { nodes, edges } = build();

	function tick() {
		if (!svg) {
			raf = 0;
			return;
		}

		const rect = svg.getBoundingClientRect();
		const cx0 = rect.left + rect.width / 2;
		const cy0 = rect.top + rect.height / 2;
		const t = time * 0.001;

		const dx = mouse.x - smooth.x;
		const dy = mouse.y - smooth.y;
		const moving = dx * dx + dy * dy > 0.5;
		if (moving) {
			smooth.x += dx * LERP;
			smooth.y += dy * LERP;
		}

		for (const node of nodes) {
			if (!node.el) continue;
			const px = cx0 + node.sx;
			const py = cy0 + node.sy;

			const breathe = 0.85 + 0.15 * Math.sin(t * 0.8 + node.phase);

			if (hasMouse) {
				const ddx = px - smooth.x;
				const ddy = py - smooth.y;
				const distSq = ddx * ddx + ddy * ddy;

				if (distSq < GLOW_SQ) {
					const prox = 1 - Math.sqrt(distSq) / GLOW;
					const p2 = prox * prox;
					node.el.setAttribute('opacity', String((node.baseOpacity + p2 * 0.55) * breathe));
					node.el.setAttribute('r', String(node.r + p2 * 2.5));
				} else {
					node.el.setAttribute('opacity', String(node.baseOpacity * breathe));
					node.el.setAttribute('r', String(node.r));
				}
			} else {
				node.el.setAttribute('opacity', String(node.baseOpacity * breathe));
				node.el.setAttribute('r', String(node.r));
			}
		}

		for (const edge of edges) {
			if (!edge.el) continue;
			const mx = (edge.a.sx + edge.b.sx) / 2;
			const my = (edge.a.sy + edge.b.sy) / 2;
			const px = cx0 + mx;
			const py = cy0 + my;
			const breathe = 0.7 + 0.3 * Math.sin(t * 0.6 + edge.a.phase + edge.b.phase);

			if (hasMouse) {
				const ddx = px - smooth.x;
				const ddy = py - smooth.y;
				const distSq = ddx * ddx + ddy * ddy;

				if (distSq < GLOW_SQ) {
					const prox = 1 - Math.sqrt(distSq) / GLOW;
					edge.el.setAttribute('opacity', String((0.1 + prox * 0.35) * breathe));
					edge.el.setAttribute('stroke-width', String(0.5 + prox * 1.2));
				} else {
					edge.el.setAttribute('opacity', String(0.1 * breathe));
					edge.el.setAttribute('stroke-width', '0.5');
				}
			} else {
				edge.el.setAttribute('opacity', String(0.1 * breathe));
				edge.el.setAttribute('stroke-width', '0.5');
			}
		}

		time += 16;
		raf = requestAnimationFrame(tick);
	}

	function onMouseMove(e: MouseEvent) {
		mouse.x = e.clientX;
		mouse.y = e.clientY;
		hasMouse = true;
	}

	function onTouchMove(e: TouchEvent) {
		if (e.touches.length > 0) {
			mouse.x = e.touches[0].clientX;
			mouse.y = e.touches[0].clientY;
			hasMouse = true;
		}
	}

	function onLeave() {
		hasMouse = false;
	}

	onMount(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		if (!svg) return;

		for (let i = 0; i < nodes.length; i++) {
			nodes[i].el = svg.querySelector(`[data-node="${i}"]`);
		}
		for (let i = 0; i < edges.length; i++) {
			edges[i].el = svg.querySelector(`[data-edge="${i}"]`);
		}

		window.addEventListener('mousemove', onMouseMove, { passive: true });
		window.addEventListener('touchmove', onTouchMove, { passive: true });
		window.addEventListener('touchend', onLeave, { passive: true });

		raf = requestAnimationFrame(tick);

		return () => {
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('touchmove', onTouchMove);
			window.removeEventListener('touchend', onLeave);
			cancelAnimationFrame(raf);
		};
	});
</script>

<svg
	bind:this={svg}
	class="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
	viewBox="-280 -180 560 360"
	preserveAspectRatio="xMidYMid slice"
	aria-hidden="true"
	style="opacity: 0.8;"
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
				stroke-width="0.5"
				opacity="0.1"
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
