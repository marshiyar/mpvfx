// @ts-expect-error -- plain ESM build script without type declarations
import { buildNativeExportFrameRuntime } from "../../scripts/build/build-native-export-frame-runtime.mjs";

export default function setup(): void {
  buildNativeExportFrameRuntime();
}
