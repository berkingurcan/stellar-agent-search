<script lang="ts">
	/**
	 * Stylized monochrome glyphs for the supported MCP clients — deliberately a
	 * uniform in-house icon set (stroke, currentColor), not official trademarks,
	 * so the row reads as one system and inherits the page's text colors.
	 */
	let { id, class: className = 'h-4 w-4' }: { id: string; class?: string } = $props();
</script>

<svg
	class={className}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.6"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#if id === 'claude-code'}
		<!-- asterisk burst -->
		<path d="M12 4.5v15M5.5 8.25l13 7.5M18.5 8.25l-13 7.5" />
	{:else if id === 'codex'}
		<!-- hex cell -->
		<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6L12 3.2z" />
		<circle cx="12" cy="12" r="2.4" />
	{:else if id === 'opencode'}
		<!-- code brackets -->
		<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.2 5.5l-2.4 13" />
	{:else if id === 'cursor'}
		<!-- isometric cube -->
		<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4l8-4.6z" />
		<path d="M12 21.2V12M12 12L4 7.4M12 12l8-4.6" />
	{:else if id === 'hermes'}
		<!-- wing -->
		<path d="M4 17.5c8.6 0 14.2-4.7 16-12-4.6 1.2-7.8 3.2-9.7 6.2" />
		<path d="M9 17c3.3-.9 5.9-2.6 7.8-5.1" />
	{:else if id === 'openclaw'}
		<!-- claw marks -->
		<path d="M6 4.5c1.9 4.6 1.9 10.4 0 15M12 3.5c2.2 5.2 2.2 11.8 0 17M18 4.5c1.9 4.6 1.9 10.4 0 15" />
	{:else}
		<!-- terminal -->
		<rect x="3" y="4.5" width="18" height="15" rx="2" />
		<path d="M7 9.5l3 2.75L7 15M12.5 15.5H17" />
	{/if}
</svg>
