import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "desktop/main.ts" },
  outDir: "desktop-dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  external: ["electron"],
});
