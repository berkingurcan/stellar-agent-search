import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/**
 * Fine-grained shiki bundle.
 *
 * `shiki/bundle/web` pulls every web language and theme — ~626 kB minified for a
 * page with three code blocks. This registers only what the page actually renders
 * (bash + json, the two GitHub default themes) and uses the JavaScript regex
 * engine rather than the Oniguruma WASM build, which drops the WASM payload too.
 *
 * Adding a language here means adding its import; there is no lazy fallback, so a
 * `lang` this module does not know about will throw and CodeBlock keeps showing
 * the plain-text version.
 */

let instance: Promise<HighlighterCore> | null = null;

export function getHighlighter(): Promise<HighlighterCore> {
	instance ??= createHighlighterCore({
		themes: [
			import('shiki/themes/github-dark-default.mjs'),
			import('shiki/themes/github-light-default.mjs')
		],
		langs: [import('shiki/langs/bash.mjs'), import('shiki/langs/json.mjs')],
		engine: createJavaScriptRegexEngine()
	});
	return instance;
}
