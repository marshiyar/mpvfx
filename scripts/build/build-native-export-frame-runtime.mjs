// Bundles the export capture page's native frame driver
// (studio/src/features/project/nativeExportFrameRuntime.entry.ts) into one
// browser script. The runtime injects it into every export page, so capture
// runs the same frame-application code as the Studio preview.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const studio = fileURLToPath(new URL("../../studio/", import.meta.url));
const esbuild = createRequire(`${studio}package.json`)("esbuild");

export const NATIVE_EXPORT_FRAME_RUNTIME_OUTPUT = `${studio}.build/runtime/native-export-frame-runtime.js`;

export function buildNativeExportFrameRuntime() {
  esbuild.buildSync({
    entryPoints: [`${studio}src/features/project/nativeExportFrameRuntime.entry.ts`],
    outfile: NATIVE_EXPORT_FRAME_RUNTIME_OUTPUT,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    legalComments: "none",
    logLevel: "warning",
  });
  return NATIVE_EXPORT_FRAME_RUNTIME_OUTPUT;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`native export frame runtime: ${buildNativeExportFrameRuntime()}`);
}
