import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { DESKTOP_CHANNELS } from "../shared/desktopBridge";

const pending = new WeakMap<BrowserWindow, Promise<void>>();

/** Keep the window and runtime alive until the editor confirms its saves. */
export function flushRendererSaves(window: BrowserWindow | null): Promise<void> {
  if (!window || window.isDestroyed()) return Promise.resolve();
  const existing = pending.get(window);
  if (existing) return existing;
  const operation = new Promise<void>((resolve, reject) => {
    const requestId = randomUUID();
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      ipcMain.removeListener(DESKTOP_CHANNELS.closePrepared, receive);
      window.webContents.removeListener("destroyed", destroyed);
      window.webContents.removeListener("did-finish-load", send);
      if (error && !window.webContents.isDestroyed()) {
        try { window.webContents.send(DESKTOP_CHANNELS.cancelClose, requestId); }
        catch { /* A disconnected renderer cannot receive cancellation. */ }
      }
      if (error) reject(error); else resolve();
    };
    const receive = (event: IpcMainEvent, id: unknown, error: unknown) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || id !== requestId) return;
      finish(error === null ? undefined : new Error(typeof error === "string" ? error : "The editor did not confirm its saves"));
    };
    const destroyed = () => finish(new Error("The editor closed before confirming its saves"));
    const send = () => {
      if (finished) return;
      try { window.webContents.send(DESKTOP_CHANNELS.prepareClose, requestId); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
    const timeout = setTimeout(() => finish(new Error("The editor is still saving or did not respond. The window has been kept open.")), 120000);
    ipcMain.on(DESKTOP_CHANNELS.closePrepared, receive);
    window.webContents.once("destroyed", destroyed);
    if (window.webContents.isLoadingMainFrame()) window.webContents.once("did-finish-load", send);
    else send();
  });
  pending.set(window, operation);
  const clear = () => { if (pending.get(window) === operation) pending.delete(window); };
  void operation.then(clear, clear);
  return operation;
}
