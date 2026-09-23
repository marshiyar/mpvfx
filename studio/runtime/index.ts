/** Load after the host configures media binaries and browser-cache paths. */
export { createStudioRuntime } from "./service";
export type { StudioRuntime, StudioRuntimeOptions } from "./service";
export type { StudioServerHost } from "./adapter";
export { closeSharedBrowser } from "./preview/browser";
