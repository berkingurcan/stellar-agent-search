import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const JAVASCRIPT_FILE = /\.(?:c|m)?js$/i;
const AXIOS_IMPLEMENTATION_MARKERS = [
  /node_modules[\\/]axios(?:[\\/]|$)/i,
  /@stellar[\\/]stellar-sdk[\\/](?:lib[\\/])?axios(?:[\\/]|$)/i,
  /\bAxiosError\b/,
  /\bAxiosHeaders\b/,
  /\baxios\.create\s*\(/,
];

async function javascriptFiles(root) {
  const output = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && JAVASCRIPT_FILE.test(entry.name)) output.push(path);
    }
  }

  await visit(root);
  return output;
}

export function assertFetchOnlyBundleText(source, label = "Worker bundle") {
  for (const marker of AXIOS_IMPLEMENTATION_MARKERS) {
    if (marker.test(source)) {
      throw new Error(`${label} contains axios implementation marker ${marker}`);
    }
  }
}

export async function assertFetchOnlyBundle(root) {
  const files = await javascriptFiles(root);
  if (files.length === 0) {
    throw new Error(`Worker dry-run emitted no JavaScript bundle under ${root}`);
  }

  for (const file of files) {
    assertFetchOnlyBundleText(await readFile(file, "utf8"), file);
  }

  return files;
}
