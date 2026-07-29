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
		// This one is a single prerendered page whose only live data is one client-side fetch to
		// the public explorer API — so it compiles to plain files and Cloudflare serves them with
		// no Worker isolate at all. Static asset requests are unbilled; Worker invocations are not.
		// See wrangler.toml for the matching assets-only config.
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			// Unknown paths get a real 404 (wrangler.toml: not_found_handling = "404-page")
			// instead of silently rendering the landing page.
			fallback: '404.html',
			precompress: false
		}),

		// CSP lives here rather than in _headers because two of the page's scripts are
		// inline — the pre-paint theme script in app.html, and SvelteKit's own hydration
		// bootstrap, whose content (and therefore hash) changes on every build. Hand-written
		// hashes in _headers would silently go stale and blank the page; SvelteKit recomputes
		// them at build time and emits them with the HTML.
		csp: {
			// 'hash', not 'nonce': every route is prerendered to a file, so there is no server
			// to mint a per-request nonce.
			mode: 'hash',
			directives: {
				'default-src': ['none'],
				// No 'unsafe-inline' — the two inline scripts are covered by build-time hashes.
				'script-src': ['self'],
				// 'unsafe-inline' IS needed here: CSP hashes do not apply to inline `style=`
				// attributes, and two exist (app.html's `display: contents` wrapper and the
				// star canvas's z-index). It stays effective only because the build emits zero
				// inline <style> blocks — if one ever appears, SvelteKit appends a style hash
				// and the browser then ignores 'unsafe-inline', so the canvas would jump to the
				// foreground. Keep component styles in .css files.
				'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
				'font-src': ['https://fonts.gstatic.com'],
				'img-src': ['self', 'data:'],
				// The page's one live read: LiveStats → stellar8004.com/api/v1/stats.
				'connect-src': ['self', 'https://stellar8004.com'],
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
