// One static page. Everything renders at build time; the only live data is a
// single client-side fetch to the public explorer API (see LiveStats.svelte),
// which keeps each visitor on their own upstream rate-limit budget instead of
// collapsing them all onto one server egress IP.
export const prerender = true;
export const ssr = true;
export const trailingSlash = 'never';
