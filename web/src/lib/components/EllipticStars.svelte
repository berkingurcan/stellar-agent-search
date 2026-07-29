<script lang="ts">
	// Ported from stellar8004.com. Ambient star field behind the whole page:
	// a fixed grid of pre-rendered star stamps that twinkle sparsely and glow
	// near the cursor. Draws to a canvas at z-index -1, pointer-events: none.
	import { onMount } from 'svelte';

	const browser = typeof window !== 'undefined';

	let canvas: HTMLCanvasElement = $state() as HTMLCanvasElement;
	let mouse = { x: -1000, y: -1000 };
	let smoothMouse = { x: -1000, y: -1000 };
	let animId: number;

	const SPACING = 44;
	const GLOW_RADIUS = 140;
	const GLOW_RADIUS_SQ = GLOW_RADIUS * GLOW_RADIUS;
	const BASE_OPACITY = 0.06;
	const MAX_OPACITY = 0.35;
	const FOLLOW_LERP = 0.1;
	const T1 = 0.09; // 0.3^2
	const T2 = 0.36; // 0.6^2
	const IDLE_THRESHOLD = 0.1;
	const RESIZE_DEBOUNCE = 150;

	// Pre-render star stamps at 3 sizes onto offscreen canvases
	const STAR_SIZES = [
		{ outer: 1.5, inner: 0.5 },
		{ outer: 2.5, inner: 0.85 },
		{ outer: 4, inner: 1.3 }
	];

	let stamps: { canvas: OffscreenCanvas; size: number }[] = [];
	let starColor = '';

	function buildStarPath(ctx: OffscreenCanvasRenderingContext2D, outerR: number, innerR: number) {
		ctx.beginPath();
		for (let i = 0; i < 10; i++) {
			const angle = -Math.PI / 2 + (i * Math.PI) / 5;
			const r = i % 2 === 0 ? outerR : innerR;
			const x = r * Math.cos(angle);
			const y = r * Math.sin(angle);
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.closePath();
	}

	function buildStamps() {
		starColor = getComputedStyle(document.documentElement)
			.getPropertyValue('--color-star-fill')
			.trim();

		stamps = STAR_SIZES.map(({ outer, inner }) => {
			const pad = 2;
			const dim = Math.ceil((outer + pad) * 2 * devicePixelRatio);
			const oc = new OffscreenCanvas(dim, dim);
			const octx = oc.getContext('2d')!;
			octx.scale(devicePixelRatio, devicePixelRatio);
			const center = outer + pad;
			octx.translate(center, center);
			octx.lineJoin = 'round';
			octx.lineCap = 'round';
			octx.lineWidth = 0.8;
			octx.fillStyle = starColor;
			octx.strokeStyle = starColor;
			buildStarPath(octx, outer, inner);
			octx.fill();
			octx.stroke();
			return { canvas: oc, size: (outer + pad) * 2 };
		});
	}

	let sx: Float32Array;
	let sy: Float32Array;
	let phase: Float32Array;
	let count = 0;
	let resizeTimer: ReturnType<typeof setTimeout>;
	let dpr = 1;

	function debouncedBuildGrid() {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(buildGrid, RESIZE_DEBOUNCE);
	}

	function buildGrid() {
		dpr = devicePixelRatio;
		const w = window.innerWidth;
		const h = window.innerHeight;
		canvas.width = w * dpr;
		canvas.height = h * dpr;
		canvas.style.width = `${w}px`;
		canvas.style.height = `${h}px`;

		const cols = Math.ceil(w / SPACING) + 1;
		const rows = Math.ceil(h / SPACING) + 1;
		const total = cols * rows;

		sx = new Float32Array(total);
		sy = new Float32Array(total);
		phase = new Float32Array(total);
		count = total;

		for (let i = 0; i < total; i++) {
			const col = i % cols;
			const row = (i / cols) | 0;
			sx[i] = col * SPACING + SPACING / 2;
			sy[i] = row * SPACING + SPACING / 2;
			phase[i] = Math.random() * 6.2832;
		}

		buildStamps();
	}

	function animate(time: number) {
		const dx = mouse.x - smoothMouse.x;
		const dy = mouse.y - smoothMouse.y;

		if (dx * dx + dy * dy > IDLE_THRESHOLD) {
			smoothMouse.x += dx * FOLLOW_LERP;
			smoothMouse.y += dy * FOLLOW_LERP;
		}

		const ctx = canvas.getContext('2d');
		if (!ctx || stamps.length === 0) {
			animId = requestAnimationFrame(animate);
			return;
		}

		ctx.clearRect(0, 0, canvas.width, canvas.height);

		const mx = smoothMouse.x;
		const my = smoothMouse.y;
		const t = time * 0.0015;
		const invR = 1 / GLOW_RADIUS;
		const range = MAX_OPACITY - BASE_OPACITY;

		for (let i = 0; i < count; i++) {
			const ddx = sx[i] - mx;
			const ddy = sy[i] - my;
			const distSq = ddx * ddx + ddy * ddy;

			const breathe = 0.85 + 0.15 * Math.sin(t + phase[i]);

			let opacity: number;
			let sIdx: number;

			if (distSq <= GLOW_RADIUS_SQ) {
				// Near cursor — glow + blink
				const dist = Math.sqrt(distSq);
				const prox = 1 - dist * invR;
				const p2 = prox * prox;
				const p3 = p2 * prox;
				sIdx = p2 > T2 ? 2 : p2 > T1 ? 1 : 0;
				const blink = 0.7 + 0.3 * Math.sin(t * 1.8 + phase[i] * 5.3);
				opacity = (BASE_OPACITY + range * p3 * breathe) * blink;
			} else {
				// Far from cursor — sparse ambient twinkle, only the brightest ~30%
				const twinkle = Math.sin(t * 0.4 + phase[i] * 3.7);
				if (twinkle < 0.4) continue;
				sIdx = 0;
				opacity = BASE_OPACITY * (0.5 + 0.5 * twinkle) * breathe;
			}

			const stamp = stamps[sIdx];
			ctx.globalAlpha = opacity;
			ctx.drawImage(
				stamp.canvas,
				(sx[i] - stamp.size / 2) * dpr,
				(sy[i] - stamp.size / 2) * dpr,
				stamp.size * dpr,
				stamp.size * dpr
			);
		}

		ctx.globalAlpha = 1;
		animId = requestAnimationFrame(animate);
	}

	function onMove(e: MouseEvent) {
		mouse.x = e.clientX;
		mouse.y = e.clientY;
	}

	// Re-build stamps when theme changes (star color changes)
	function onThemeChange() {
		const newColor = getComputedStyle(document.documentElement)
			.getPropertyValue('--color-star-fill')
			.trim();
		if (newColor !== starColor) {
			buildStamps();
		}
	}

	onMount(() => {
		// Respect reduced-motion: the field is decorative, so skip it entirely
		// rather than render a frozen grid of dots over the content.
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

		buildGrid();
		window.addEventListener('mousemove', onMove, { passive: true });
		window.addEventListener('resize', debouncedBuildGrid);
		animId = requestAnimationFrame(animate);

		const observer = new MutationObserver(onThemeChange);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

		return () => {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('resize', debouncedBuildGrid);
			clearTimeout(resizeTimer);
			cancelAnimationFrame(animId);
			observer.disconnect();
		};
	});
</script>

{#if browser}
	<canvas bind:this={canvas} class="pointer-events-none fixed inset-0" style="z-index: -1;"></canvas>
{/if}
