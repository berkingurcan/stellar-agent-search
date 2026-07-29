<script lang="ts">
	import { onMount } from 'svelte';

	let svg = $state<SVGSVGElement>();
	let raf = 0;
	let mouse = { x: -9999, y: -9999 };
	let smooth = { x: -9999, y: -9999 };
	let hasMouse = false;

	const GLOW = 180;
	const GLOW_SQ = GLOW * GLOW;
	const LERP = 0.05;

	const COLS = 5;
	const ROWS = 5;
	const TILE = 60;
	const ISO_X = 0.866;
	const ISO_Y = 0.5;

	type Node = {
		sx: number;
		sy: number;
		r: number;
		phase: number;
		el: SVGCircleElement | null;
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
				const radiusStep = (col * 17 + row * 31) % 7;
				const phaseStep = (col * 13 + row * 23) % 100;
				n.push({
					sx: isoX(col, row),
					sy: isoY(col, row),
					r: 1.5 + radiusStep * 0.2,
					phase: (phaseStep / 100) * Math.PI * 2,
					el: null
				});
			}
		}
		for (let i = 0; i < n.length; i++) {
			const node = n[i];
			const right = n.find((m) => m.sx === isoX(col(node) + 1, row(node)) && m.sy === isoY(col(node) + 1, row(node)));
			if (i < n.length - 1 && i % COLS !== COLS - 1) e.push({ a: node, b: n[i + 1], el: null });
			if (i + COLS < n.length) e.push({ a: node, b: n[i + COLS], el: null });
		}
		return { nodes: n, edges: e };
	}

	function col(n: Node) {
		return Math.round((n.sx / (TILE * ISO_X) + n.sy / (TILE * ISO_Y)) / 2);
	}
	function row(n: Node) {
		return Math.round((n.sy / (TILE * ISO_Y) - n.sx / (TILE * ISO_X)) / 2);
	}

	const { nodes, edges } = build();

	let time = 0;

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
			const breathe = 0.8 + 0.2 * Math.sin(t * 0.6 + node.phase);

			if (hasMouse) {
				const ddx = px - smooth.x;
				const ddy = py - smooth.y;
				const distSq = ddx * ddx + ddy * ddy;
				if (distSq < GLOW_SQ) {
					const prox = 1 - Math.sqrt(distSq) / GLOW;
					node.el.setAttribute('opacity', String((0.1 + prox * prox * 0.5) * breathe));
					node.el.setAttribute('r', String(node.r + prox * prox * 2));
				} else {
					node.el.setAttribute('opacity', String(0.1 * breathe));
					node.el.setAttribute('r', String(node.r));
				}
			} else {
				node.el.setAttribute('opacity', String(0.1 * breathe));
				node.el.setAttribute('r', String(node.r));
			}
		}

		for (const edge of edges) {
			if (!edge.el) continue;
			const mx = (edge.a.sx + edge.b.sx) / 2;
			const my = (edge.a.sy + edge.b.sy) / 2;
			const px = cx0 + mx;
			const py = cy0 + my;
			const breathe = 0.6 + 0.4 * Math.sin(t * 0.4 + edge.a.phase);

			if (hasMouse) {
				const ddx = px - smooth.x;
				const ddy = py - smooth.y;
				const distSq = ddx * ddx + ddy * ddy;
				if (distSq < GLOW_SQ) {
					const prox = 1 - Math.sqrt(distSq) / GLOW;
					edge.el.setAttribute('opacity', String((0.06 + prox * 0.25) * breathe));
				} else {
					edge.el.setAttribute('opacity', String(0.06 * breathe));
				}
			} else {
				edge.el.setAttribute('opacity', String(0.06 * breathe));
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
	viewBox="-200 -140 400 280"
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
				opacity="0.06"
			/>
		{/each}
		{#each nodes as node, i (i)}
			<circle
				data-node={i}
				cx={node.sx}
				cy={node.sy}
				r={node.r}
				fill="var(--color-text-dim)"
				opacity="0.1"
			/>
		{/each}
	</g>
</svg>
