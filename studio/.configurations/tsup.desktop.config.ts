import { defineConfig } from "tsup";
import { fileURLToPath } from "node:url";

export default defineConfig([{
  entry: { main: fileURLToPath(new URL("../desktop/main.ts", import.meta.url)) },
  tsconfig: fileURLToPath(new URL("./tsconfig.desktop.json", import.meta.url)),
  outDir: fileURLToPath(new URL("../.build/desktop-dist", import.meta.url)),
  format: ["esm"],
  platform: "node",
  target: "node24",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: ["main.js", "main.js.map"],
  dts: false,
  external: ["electron"],
}, {
  entry: { preload: fileURLToPath(new URL("../desktop/preload.ts", import.meta.url)) },
  tsconfig: fileURLToPath(new URL("./tsconfig.desktop.json", import.meta.url)),
  outDir: fileURLToPath(new URL("../.build/desktop-dist/preload", import.meta.url)),
  format: ["cjs"],
  platform: "node",
  target: "node24",
  bundle: true,
  clean: true,
  external: ["electron"],
  outExtension: () => ({ js: ".cjs" }),
}]);
