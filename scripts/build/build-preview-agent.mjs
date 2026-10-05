// Build the unprivileged DOM adapter served only to isolated authored previews.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const studio = fileURLToPath(new URL("../../studio/", import.meta.url));
const esbuild = createRequire(`${studio}package.json`)("esbuild");

export const PREVIEW_AGENT_OUTPUT = `${studio}.build/runtime/preview-agent.js`;

export function buildPreviewAgent() {
  esbuild.buildSync({
    entryPoints: [`${studio}src/features/preview/agentEntry.ts`],
    outfile: PREVIEW_AGENT_OUTPUT,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    legalComments: "none",
    logLevel: "warning",
  });
  return PREVIEW_AGENT_OUTPUT;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`preview agent: ${buildPreviewAgent()}`);
}
