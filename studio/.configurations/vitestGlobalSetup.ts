// @ts-expect-error -- plain ESM build script without type declarations
import { buildNativeExportFrameRuntime } from "../../scripts/build/build-native-export-frame-runtime.mjs";
// @ts-expect-error -- plain ESM build script without type declarations
import { buildPreviewAgent } from "../../scripts/build/build-preview-agent.mjs";

export default function setup(): void {
  buildNativeExportFrameRuntime();
  buildPreviewAgent();
}
