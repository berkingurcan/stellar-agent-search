import type { Action } from 'svelte/action';

/**
 * Subtle scroll-triggered reveal. Opacity + 8px translate, 500ms with
 * expo ease-out. Fires once, then disconnects the observer — zero
 * ongoing cost. Respects prefers-reduced-motion (shows immediately).
 */
export const reveal: Action<HTMLElement, number | undefined> = (node, delay = 0) => {
	if (
		typeof window !== 'undefined' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	) {
		return;
	}

	node.style.opacity = '0';
	node.style.transform = 'translateY(8px)';
	node.style.transition = `opacity 0.5s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms, transform 0.5s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`;

	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					node.style.opacity = '1';
					node.style.transform = 'none';
					observer.unobserve(node);
				}
			}
		},
		{ threshold: 0.08, rootMargin: '0px 0px -40px 0px' }
	);

	observer.observe(node);

	return {
		destroy() {
			observer.disconnect();
		}
	};
};
