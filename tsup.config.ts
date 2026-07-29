import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  // Build-time vendor the exact-pinned canonical SDK implementation. The npm
  // artifact is bin-only, so consumers should not install a second v15 SDK
  // merely to run our read-only CLI. THIRD_PARTY_NOTICES.md carries the MIT
  // attribution for the code embedded here.
  noExternal: ["@trionlabs/stellar8004"],
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
