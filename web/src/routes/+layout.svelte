<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { theme } from '$lib/theme.svelte.js';
	import EllipticStars from '$lib/components/EllipticStars.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { GITHUB, NPM, EXPLORER } from '$lib/links.js';

	let { children } = $props();

	onMount(() => {
		theme.init();
	});
</script>

<EllipticStars />

<div class="flex min-h-screen flex-col text-text">
	<header class="sticky top-0 z-50 border-b border-border-subtle/60 bg-surface/80 backdrop-blur-md">
		<nav class="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-2.5">
			<a href="{base}/" class="flex items-center gap-2 text-text">
				<img src="{base}/favicon.svg" alt="" class="h-4 w-4" />
				<span class="font-mono text-[12px]">stellar-agent-mcp</span>
			</a>

			<div class="flex items-center gap-0.5">
				<a href="#why" class="nav-link hidden sm:inline-flex">Why</a>
				<a href="#output" class="nav-link hidden sm:inline-flex">Output</a>
				<a href="#install" class="nav-link">Install</a>
				<a href="#tools" class="nav-link hidden sm:inline-flex">Surface</a>

				<span class="mx-1.5 hidden h-3.5 w-px bg-border sm:block"></span>

				<a
					href={EXPLORER}
					target="_blank"
					rel="noopener noreferrer"
					class="nav-link hidden lg:inline-flex"
					title="stellar8004.com — the registry this server reads"
				>
					Explorer
				</a>
				<a
					href={GITHUB}
					target="_blank"
					rel="noopener noreferrer"
					class="nav-link"
					aria-label="GitHub repository"
				>
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path
							d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
						/>
					</svg>
				</a>
				<ThemeToggle />
			</div>
		</nav>
	</header>

	<main class="relative z-10 mx-auto w-full max-w-5xl flex-1 px-6 py-20">
		{@render children()}
	</main>

	<footer class="relative z-10 mt-auto border-t border-border-subtle">
		<div
			class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-6 text-[11px] text-text-dim"
		>
			<div class="flex flex-wrap items-center gap-3">
				<span class="font-mono">stellar-agent-mcp</span>
				<span class="text-border">&middot;</span>
				<span>MIT</span>
				<span class="text-border">&middot;</span>
				<span>
					Companion to
					<a
						href={EXPLORER}
						target="_blank"
						rel="noopener noreferrer"
						class="transition hover:text-text-muted">stellar8004.com</a
					>
				</span>
			</div>
			<div class="flex flex-wrap items-center gap-4">
				<a
					href="{GITHUB}/tree/main/docs"
					target="_blank"
					rel="noopener noreferrer"
					class="transition hover:text-text-muted">Docs</a
				>
				<a
					href="{GITHUB}/blob/main/SECURITY.md"
					target="_blank"
					rel="noopener noreferrer"
					class="transition hover:text-text-muted">Security</a
				>
				<a href={NPM} target="_blank" rel="noopener noreferrer" class="transition hover:text-text-muted"
					>npm</a
				>
				<a
					href={GITHUB}
					target="_blank"
					rel="noopener noreferrer"
					class="transition hover:text-text-muted"
					aria-label="GitHub"
				>
					<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path
							d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
						/>
					</svg>
				</a>
			</div>
		</div>
	</footer>
</div>
