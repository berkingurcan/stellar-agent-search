import adapter from '@sveltejs/adapter-static';
import { relative, sep } from 'node:path';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Rune mode for our own source, legacy mode for node_modules. Can be dropped in Svelte 6.
		runes: ({ filename }) => {
			const relativePath = relative(import.meta.dirname, filename);
			const isExternalLibrary = relativePath.toLowerCase().split(sep).includes('node_modules');
			return isExternalLibrary ? undefined : true;
		}
	},
	kit: {
		// adapter-static, NOT adapter-cloudflare (which stellar8004.com uses). That site has
		// server routes, Supabase service-role secrets and form actions, so it needs a Worker.
		// This one is a single prerendered page with captured, date-stamped examples and no live
		// data fetch, so it compiles to plain files and Cloudflare serves it without a Worker
		// isolate. Static asset requests are unbilled; Worker invocations are not.
		// See wrangler.toml for the matching assets-only config.
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			// Unknown paths get a real 404 (wrangler.toml: not_found_handling = "404-page")
			// instead of silently rendering the landing page.
			fallback: '404.html',
			precompress: false
		}),

		// CSP lives here rather than in _headers because SvelteKit's hydration bootstrap is
		// inline and its content (and therefore hash) changes per route and build. The
		// pre-paint theme initializer is an external same-origin file, so every generated
		// page has only the hydration hash to maintain. Hand-written hashes in _headers
		// would silently go stale and blank the page; SvelteKit recomputes them at build time.
		csp: {
			// 'hash', not 'nonce': every route is prerendered to a file, so there is no server
			// to mint a per-request nonce.
			mode: 'hash',
			directives: {
				'default-src': ['none'],
				// No 'unsafe-inline' — the hydration bootstrap is covered by a build-time hash.
				'script-src': ['self'],
				// 'unsafe-inline' IS needed here: CSP hashes do not apply to inline `style=`
				// attributes, including app.html's `display: contents` wrapper and the ranking
				// progress widths. It stays effective only because the build emits zero
				// inline <style> blocks — if one ever appears, SvelteKit appends a style hash
				// and the browser then ignores 'unsafe-inline', so those attributes would stop
				// applying. Keep component styles in .css files.
				'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
				'font-src': ['https://fonts.gstatic.com'],
				'img-src': ['self', 'data:'],
				// No cross-origin API calls: evidence shown on the page is a captured transcript.
				'connect-src': ['self'],
				'base-uri': ['none'],
				'form-action': ['none']
				// frame-ancestors is deliberately absent: SvelteKit delivers this policy as a
				// <meta http-equiv> tag on prerendered pages, and browsers ignore frame-ancestors
				// there. It is set as a real header in static/_headers instead.
			}
		}
	}
};

export default config;
