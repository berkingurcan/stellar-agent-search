import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(WEB_ROOT, 'build');
const rootPackage = JSON.parse(await readFile(resolve(WEB_ROOT, '..', 'package.json'), 'utf8'));
const packageSpec = `${rootPackage.name}@${rootPackage.version}`;
const repositoryUrl = rootPackage.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
const npmUrl = `https://www.npmjs.com/package/${rootPackage.name}`;
const selector = await readFile(join(WEB_ROOT, 'src/lib/install.ts'), 'utf8');
const publishedInstallSource = await readFile(
	join(WEB_ROOT, 'src/lib/install-published.ts'),
	'utf8'
);
const expectedInstallConfigs = [
	...publishedInstallSource.matchAll(/\bid:\s*['"]([^'"]+)['"]/g)
].map((match) => match[1]);
const pending = selector.includes("export * from './install-pending.js'");
const published = selector.includes("export * from './install-published.js'");

if (pending === published) {
	throw new Error('install.ts must select exactly one release surface');
}

const textExtensions = new Set(['.html', '.js', '.css', '.json', '.txt', '.xml', '.svg']);
const files = [];
async function walk(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await walk(path);
		else if (entry.isFile() && textExtensions.has(extname(entry.name))) files.push(path);
	}
}
await walk(BUILD);

const command = /npx\s+(?:(?:--yes|-y)\s+)?stellar-agent-market(?:@[^\s"'`]+)?(?:\s|["'`])/i;
let exactPinnedCommandFound = false;
let installSectionCount = 0;
const installConfigsFound = new Set();
for (const path of files) {
	const contents = await readFile(path, 'utf8');
	if (contents.includes(`npx -y ${packageSpec}`)) exactPinnedCommandFound = true;
	if (extname(path) === '.html') {
		installSectionCount += [...contents.matchAll(/\bid=["']install["']/gi)].length;
	}
	for (const match of contents.matchAll(/data-install-config=["']([^"']+)["']/gi)) {
		installConfigsFound.add(match[1]);
	}
	for (const match of contents.matchAll(/stellar-agent-market@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/g)) {
		if (match[0] !== packageSpec) {
			throw new Error(`built landing contains stale package pin ${match[0]} (expected ${packageSpec}) in ${path}`);
		}
	}
	if (pending && command.test(contents)) {
		throw new Error(`pre-release build leaks an executable unclaimed-package command in ${path}`);
	}
	if (published) {
		for (const match of contents.matchAll(
			/npx\s+(?:(?:--yes|-y)\s+)?(stellar-agent-market(?:@[^\s"'`<>]+)?)(?=\s|["'`<])/gi
		)) {
			if (match[1] !== packageSpec) {
				throw new Error(`published build contains an unpinned or mismatched command for ${match[1]} in ${path}`);
			}
		}
	}
	if (pending && (contents.includes(repositoryUrl) || contents.includes(npmUrl))) {
		throw new Error(`pre-release build exposes a private repository or unclaimed npm package in ${path}`);
	}

	if (extname(path) === '.html') {
		const cspMatch = contents.match(
			/<meta\s+http-equiv=["']content-security-policy["']\s+content="([^"]+)"/i
		);
		const csp = cspMatch?.[1];
		if (!csp) throw new Error(`generated HTML is missing its CSP meta policy in ${path}`);
		const scriptSources =
			csp.match(/(?:^|;)\s*script-src\s+([^;]+)/i)?.[1]?.trim().split(/\s+/) ?? [];
		if (!scriptSources.includes('https://static.cloudflareinsights.com')) {
			throw new Error(
				`generated CSP does not permit the zone-injected Cloudflare RUM beacon in ${path}`
			);
		}
		const connectSources = csp.match(/(?:^|;)\s*connect-src\s+([^;]+)/i)?.[1]?.trim();
		if (connectSources !== "'self'") {
			throw new Error(`generated CSP must keep beacon reporting same-origin only in ${path}`);
		}
		const firstGovernedResource = contents.search(/<(?:script|link)\b/i);
		if (
			firstGovernedResource !== -1 &&
			(cspMatch.index === undefined || cspMatch.index > firstGovernedResource)
		) {
			throw new Error(`generated CSP appears after a resource or script in ${path}`);
		}

		for (const match of contents.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
			if (/\bsrc\s*=/i.test(match[1] ?? '')) continue;
			const source = match[2] ?? '';
			if (!source.trim()) continue;
			const hash = createHash('sha256').update(source).digest('base64');
			if (!csp.includes(`'sha256-${hash}'`)) {
				throw new Error(`generated HTML contains an inline script without its CSP hash in ${path}`);
			}
		}
	}
}

if (published && !exactPinnedCommandFound) {
	throw new Error(`published build does not contain the exact version-pinned install command for ${packageSpec}`);
}
if (pending && installSectionCount !== 0) {
	throw new Error('pre-release build exposes an install anchor before package ownership is verified');
}
if (published && installSectionCount !== 1) {
	throw new Error(`published build must contain exactly one #install section (found ${installSectionCount})`);
}
if (
	published &&
	(expectedInstallConfigs.length === 0 ||
		expectedInstallConfigs.some((config) => !installConfigsFound.has(config)))
) {
	throw new Error('published build does not prerender every declared install configuration');
}

process.stdout.write(
	`${pending ? 'pre-release' : 'published'} landing build release surface is internally consistent\n`
);
