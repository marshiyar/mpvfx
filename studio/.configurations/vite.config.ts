// Compile the UI loaded by Electron's BrowserWindow.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertInstalledExactKeyframeWriter } from "../runtime/environment";
import { resolveInstalledMediaBinaryPaths } from "../desktop/installedMediaBinaries";
import { applyBundledMediaBinaryEnvironment } from "../desktop/runtimeBinaries";

const studioPkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
applyBundledMediaBinaryEnvironment(resolveInstalledMediaBinaryPaths());
assertInstalledExactKeyframeWriter();

export default defineConfig({
  root: resolve(__dirname, ".."),
  plugins: [react()],
  css: { postcss: __dirname },
  define: { __STUDIO_VERSION__: JSON.stringify(studioPkg.version) },
  build: {
    outDir: ".build/dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id): string | undefined {
          if (id.includes("/node_modules/@hyperframes/player/")) return "mpvfx-player";
          return undefined;
        },
      },
    },
  },
});
