/** Startup checks are safe before the renderer/browser dependency graph loads. */
export { assertBundledMediaBinariesAvailable } from "./media/binaries";
export { assertInstalledExactKeyframeWriter } from "./projects/keyframeMutationExactness";
