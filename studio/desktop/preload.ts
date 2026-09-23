import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_CHANNELS, type DesktopBridge, type DesktopEvent } from "../shared/desktopBridge";

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

if (process.isMainFrame) contextBridge.exposeInMainWorld("mpvfx", bridge);
