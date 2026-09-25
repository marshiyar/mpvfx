import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_CHANNELS, type DesktopBridge, type DesktopEvent } from "../shared/desktopBridge";
import type { VkfEngineBridge, VkfNativeModule, VkfTrack } from "../shared/engine/vkfEngine";
import { ENGINE_MODULE_ARGUMENT } from "./windowPolicy";

// Keep Electron objects and event.sender out of the renderer's JavaScript context.
const bridge: DesktopBridge = {
  request: (request) => ipcRenderer.invoke(DESKTOP_CHANNELS.request, request),
  cancel: (id) => ipcRenderer.send(DESKTOP_CHANNELS.cancel, id),
  subscribe(path, listener) {
    const id = crypto.randomUUID();
    let closed = false;
    const receive = (_event: Electron.IpcRendererEvent, subscriptionId: string, event: DesktopEvent) => {
      if (!closed && id === subscriptionId) listener(event);
    };
    ipcRenderer.on(DESKTOP_CHANNELS.event, receive);
    void ipcRenderer.invoke(DESKTOP_CHANNELS.subscribe, id, path).catch(() => {
      if (!closed) listener({ type: "error", data: "Subscription failed" });
    });
    return () => {
      closed = true;
      ipcRenderer.removeListener(DESKTOP_CHANNELS.event, receive);
      ipcRenderer.send(DESKTOP_CHANNELS.unsubscribe, id);
    };
  },
};

/**
 * The C++ engine runs in this process, called synchronously by the editor.
 * Compiled tracks stay here; the page only holds numeric handles.
 */
function createEngineBridge(modulePath: string): VkfEngineBridge {
  const engine = require(modulePath) as VkfNativeModule;
  const compiled = new Map<number, unknown>();
  let nextHandle = 1;
  const lookup = (handle: number): unknown => {
    const track = compiled.get(handle);
    if (track === undefined) throw new Error(`Unknown engine track handle ${handle}`);
    return track;
  };
  return {
    apiVersion: engine.apiVersion,
    version: engine.version,
    compile(track: VkfTrack) {
      try {
        const handle = nextHandle++;
        compiled.set(handle, engine.compileTrack(track));
        return { handle };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return {
          code: typeof code === "string" ? code : "engine-internal",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    evaluate: (handle, frame) => engine.evaluateTrack(lookup(handle), frame),
    sample: (handle, firstFrame, count) => engine.sampleTrack(lookup(handle), firstFrame, count),
    tangentAngle: (handle, frame) => engine.trackTangentAngle(lookup(handle), frame),
    slice: (handle, fromFrame, until) => engine.sliceTrack(lookup(handle), fromFrame, until),
    release: (handle) => {
      compiled.delete(handle);
    },
  };
}

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("mpvfx", bridge);
  const moduleArgument = process.argv.find((value) => value.startsWith(ENGINE_MODULE_ARGUMENT));
  if (moduleArgument) {
    contextBridge.exposeInMainWorld("vkfEngine", createEngineBridge(moduleArgument.slice(ENGINE_MODULE_ARGUMENT.length)));
  }
}
