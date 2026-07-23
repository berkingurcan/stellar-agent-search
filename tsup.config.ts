import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  dts: true,
  clean: true,
  sourcemap: true,
  // The bin needs a shebang; inject via banner (not in source, to avoid a
  // duplicate line when the file is also imported as a module).
  banner: { js: "#!/usr/bin/env node" },
  // npm marks bin files +x on install; chmod so `node dist/index.js` /
  // npx-from-checkout also work locally.
  onSuccess: "chmod +x dist/index.js",
});
