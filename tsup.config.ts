import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  // The bin needs a shebang; inject via banner (not in source, to avoid a
  // duplicate line. This package is intentionally bin-only: importing this
  // entry would execute the CLI, so package.json exposes no library entry.
  banner: { js: "#!/usr/bin/env node" },
  // npm marks bin files +x on install; chmod so `node dist/index.js` /
  // npx-from-checkout also work locally.
  onSuccess: "chmod +x dist/index.js",
});
