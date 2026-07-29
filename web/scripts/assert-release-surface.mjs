import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(WEB_ROOT, 'build');
const selector = await readFile(join(WEB_ROOT, 'src/lib/install.ts'), 'utf8');
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

const command = /npx\s+(?:(?:--yes|-y)\s+)?stellar-agent-mcp(?:@0\.1\.0)?(?:\s|["'`])/i;
let exactPinnedCommandFound = false;
for (const path of files) {
	const contents = await readFile(path, 'utf8');
	if (contents.includes('npx -y stellar-agent-mcp@0.1.0')) exactPinnedCommandFound = true;
	if (pending && command.test(contents)) {
		throw new Error(`pre-release build leaks an executable unclaimed-package command in ${path}`);
	}
}

if (published && !exactPinnedCommandFound) {
	throw new Error('published build does not contain the exact version-pinned install command');
}

process.stdout.write(
	`${pending ? 'pre-release' : 'published'} landing build release surface is internally consistent\n`
);
