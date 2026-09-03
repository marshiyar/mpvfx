import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createStudioHttpService } from "./studio.http-service";
import { assertInstalledExactKeyframeWriter } from "./vite.keyframe-mutation-exactness";
import { resolveInstalledMediaBinaryPaths } from "./desktop/installedMediaBinaries";
import { applyBundledMediaBinaryEnvironment } from "./desktop/runtimeBinaries";

const studioPkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));
applyBundledMediaBinaryEnvironment(resolveInstalledMediaBinaryPaths());

// ── Vite plugin ──────────────────────────────────────────────────────────────

function devProjectApi(): Plugin {
  // Fail every Vite entrypoint (development, tests, and production build) when
  // dependency installation skipped the exact-writer postinstall. Shipping or
  // opening a project with the old fuzzy writer is less safe than refusing to
  // start with an actionable repair command.
  assertInstalledExactKeyframeWriter();
  const localProjectsDir = resolve(__dirname, "data/projects");
  const dataDir = process.env.MPVFX_PROJECTS_DIR
    ? resolve(process.env.MPVFX_PROJECTS_DIR)
    : existsSync(localProjectsDir)
      ? localProjectsDir
      : resolve(__dirname, "fixtures");

  return {
    name: "studio-dev-api",
    configureServer(server): void {
      const service = createStudioHttpService({
        projectsDir: dataDir,
        version: studioPkg.version,
        adapterHost: {
          studioDir: __dirname,
          async loadModule<T>(specifier: string): Promise<T> {
            return (await server.ssrLoadModule(specifier)) as T;
          },
        },
        onFileChange: (data) => {
          server.ws.send({ type: "custom", event: "hf:file-change", data });
        },
      });
      server.middlewares.use(async (req, res, next) => {
        if (!(await service.handle(req, res))) next();
      });
      server.httpServer?.on("close", () => {
        void service.close();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devProjectApi()],
  define: {
    __STUDIO_VERSION__: JSON.stringify(studioPkg.version),
  },
  build: {
    outDir: "dist",
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
  optimizeDeps: {
    include: ["bpm-detective"],
  },
  server: {
    port: 5190,
    watch: {
      // A composition lives under this package's root, so Vite's HMR sees a
      // write to one as an html page dependency changing and full-reloads the
      // browser. That reload is the flash after every edit in the canvas, and
      // it is not Studio's to make: the app already decides whether a write of
      // its own needs the preview refreshed, and the plugin below announces
      // project writes as `hf:file-change` off its own watcher.
      ignored: ["**/data/projects/**"],
    },
  },
  ssr: {
    // recast / @babel/parser are CommonJS and call `require("fs")`. They are
    // reachable only server-side via the Node-only `@hyperframes/parsers/gsap-parser`
    // subpath (studio-api GSAP mutations + the linter), which the dev server loads
    // through Vite SSR. Externalizing them makes SSR load the native Node modules
    // instead of esbuild-transforming the `require` into a shim that throws
    // "Dynamic require of fs is not supported". Browser bundles never reach them.
    external: ["recast", "@babel/parser", "ast-types"],
  },
});
