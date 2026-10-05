import { contextBridge, ipcRenderer, webUtils } from "electron";
import { DESKTOP_CHANNELS, type DesktopBridge, type DesktopEvent } from "../shared/desktopBridge";
import type { VkfEngineBridge, VkfNativeModule, VkfTrack } from "../shared/engine/vkfEngine";
import { ENGINE_MODULE_ARGUMENT } from "./windowPolicy";

type CloseHandler = { flush: () => Promise<void>; cancel?: () => void };
const closeHandlers = new Set<CloseHandler>();
const closeRequests = new Map<string, CloseHandler[]>();

// Install the IPC receiver before React mounts. A window closed during startup
// has no editor changes, and must not wait for a hook that is not mounted yet.
ipcRenderer.on(DESKTOP_CHANNELS.prepareClose, (_event, id: unknown) => {
  if (typeof id !== "string" || closeRequests.has(id)) return;
  const handlers = [...closeHandlers];
  closeRequests.set(id, handlers);
  void Promise.allSettled(handlers.map(handler => Promise.resolve().then(handler.flush))).then(results => {
    if (!closeRequests.has(id)) return;
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    ipcRenderer.send(DESKTOP_CHANNELS.closePrepared, id,
      failure ? failure.reason instanceof Error ? failure.reason.message : String(failure.reason) : null);
  });
});
ipcRenderer.on(DESKTOP_CHANNELS.cancelClose, (_event, id: unknown) => {
  if (typeof id !== "string") return;
  const handlers = closeRequests.get(id);
  if (!handlers) return;
  closeRequests.delete(id);
  for (const handler of handlers) handler.cancel?.();
});

// Keep Electron objects and event.sender out of the renderer's JavaScript context.
const bridge: DesktopBridge = {
  openCrosspost: (projectId, filename) => ipcRenderer.invoke(DESKTOP_CHANNELS.crosspost, projectId, filename),
  onPrepareClose(flush, cancel) {
    const handler = { flush, cancel };
    closeHandlers.add(handler);
    return () => { closeHandlers.delete(handler); };
  },
  library: command => ipcRenderer.invoke(DESKTOP_CHANNELS.library, command),
  importFiles: (projectId, files, directory) => {
    const paths = files.map(file => webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]));
    if (paths.some(path => !path)) return Promise.resolve(null);
    return ipcRenderer.invoke(DESKTOP_CHANNELS.importFiles, projectId, paths, directory);
  },
  request: (request) => ipcRenderer.invoke(DESKTOP_CHANNELS.request, request),
  cancel: (id) => ipcRenderer.send(DESKTOP_CHANNELS.cancel, id),
  subscribe(path, listener) {
    const id = crypto.randomUUID();
    let closed = false;
    const receive = (_event: Electron.IpcRendererEvent, subscriptionId: string, event: DesktopEvent) => {
      if (!closed && id === subscriptionId) listener(event);
    };
    ipcRenderer.on(DESKTOP_CHANNELS.event, receive);
    void ipcRenderer.invoke(DESKTOP_CHANNELS.subscribe, id, path).then(() => {
      if (!closed) listener({ type: "ready", data: "" });
    }).catch(() => {
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
