import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ipcMain, protocol, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import { createStudioRuntime } from "../runtime/index";
import { DESKTOP_CHANNELS, DESKTOP_ORIGIN, type DesktopRequest, type DesktopResponse } from "../shared/desktopBridge";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon",
  ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm",
};
const EDITOR_CSP = [
  "default-src 'self' blob: data:", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'", "frame-src 'self' blob:", "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'",
].join("; ");

function within(root: string, file: string): boolean {
  const offset = relative(root, file);
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
}

export function isEditorDocument(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "mpvfx:" && parsed.host === "editor" &&
      parsed.pathname === "/";
  } catch { return false; }
}

export function isResourcePath(path: string): boolean {
  return /^\/api\/projects\/[^/]+\/(?:preview|thumbnail|waveform)(?:\/|$)/.test(path) ||
    /^\/api\/projects\/[^/]+\/renders\/file\//.test(path) ||
    /^\/api\/render\/[^/]+\/(?:view|download)$/.test(path) ||
    ["/api/runtime.js", "/api/motion-path-plugin.js", "/api/fonts/file"].includes(path);
}

interface Options {
  staticDir: string;
  projectsDir: string;
  studioDir: string;
  editorContents(): WebContents | undefined;
}

/** Owns native commands, subscriptions and packaged resources. Opens no network listener. */
export async function startEditorRuntime(options: Options) {
  const runtime = createStudioRuntime({
    projectsDir: options.projectsDir,
    adapterHost: {
      studioDir: options.studioDir,
      async loadModule<T>(specifier: string): Promise<T> {
        return import(isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier) as T;
      },
    },
  });
  const requests = new Map<string, AbortController>();
  const subscriptions = new Map<string, (() => void) | null>();
  let closed = false;
  let contents: WebContents | undefined;
  const releaseRenderer = () => {
    for (const controller of requests.values()) controller.abort();
    requests.clear();
    for (const stop of subscriptions.values()) stop?.();
    subscriptions.clear();
  };
  const assertEditor = (event: IpcMainInvokeEvent | IpcMainEvent) => {
    if (closed || event.sender !== options.editorContents() ||
        event.senderFrame !== event.sender.mainFrame || !isEditorDocument(event.senderFrame?.url ?? "")) {
      throw new Error("Untrusted desktop command sender");
    }
    if (contents !== event.sender) {
      releaseRenderer();
      contents = event.sender;
      contents.once("destroyed", releaseRenderer);
      contents.on("render-process-gone", releaseRenderer);
    }
  };
  const key = (event: IpcMainEvent | IpcMainInvokeEvent, id: string) => `${event.sender.id}:${id}`;
  const dispatch = async (event: IpcMainInvokeEvent, input: DesktopRequest): Promise<DesktopResponse> => {
    assertEditor(event);
    if (!input || typeof input.id !== "string" || typeof input.path !== "string" ||
        !input.path.startsWith("/api/") || /[\\\r\n#]/.test(input.path) ||
        !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(input.method) ||
        !Array.isArray(input.headers) || (input.body !== undefined && !(input.body instanceof ArrayBuffer))) {
      throw new Error("Invalid desktop command");
    }
    const requestKey = key(event, input.id);
    if (requests.has(requestKey)) throw new Error("Duplicate desktop command");
    const controller = new AbortController();
    requests.set(requestKey, controller);
    try {
      const response = await runtime.handle(new Request(`${DESKTOP_ORIGIN}${input.path}`, {
        method: input.method, headers: input.headers, body: input.body, signal: controller.signal,
      }));
      return {
        status: response.status, statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
        body: response.body ? await response.arrayBuffer() : null,
      };
    } finally { requests.delete(requestKey); }
  };
  const cancel = (event: IpcMainEvent, id: string) => {
    if (event.sender === contents) requests.get(key(event, id))?.abort();
  };
  const unsubscribe = (event: IpcMainEvent, id: string) => {
    const subscriptionKey = key(event, id);
    subscriptions.get(subscriptionKey)?.();
    subscriptions.delete(subscriptionKey);
  };
  ipcMain.handle(DESKTOP_CHANNELS.request, dispatch);
  ipcMain.on(DESKTOP_CHANNELS.cancel, cancel);
  ipcMain.handle(DESKTOP_CHANNELS.subscribe, async (event, id: string, path: string) => {
    assertEditor(event);
    if (typeof id !== "string" || typeof path !== "string") throw new Error("Invalid subscription");
    const subscriptionKey = key(event, id);
    if (subscriptions.has(subscriptionKey)) throw new Error("Duplicate subscription");
    subscriptions.set(subscriptionKey, null);
    try {
      const stop = await runtime.subscribe(path, (message) => {
        if (!event.sender.isDestroyed() && subscriptions.has(subscriptionKey)) {
          event.sender.send(DESKTOP_CHANNELS.event, id, message);
        }
      });
      if (closed || !subscriptions.has(subscriptionKey)) stop();
      else subscriptions.set(subscriptionKey, stop);
    } catch (error) { subscriptions.delete(subscriptionKey); throw error; }
  });
  ipcMain.on(DESKTOP_CHANNELS.unsubscribe, unsubscribe);

  protocol.handle("mpvfx", async (request) => {
    const url = new URL(request.url);
    if (closed || url.host !== "editor") return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    if (url.pathname.startsWith("/api/")) {
      return isResourcePath(url.pathname) ? runtime.handle(request) : new Response(null, { status: 403 });
    }
    try {
      const root = await realpath(options.staticDir);
      const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const file = await realpath(resolve(root, `.${requested}`));
      if (!within(root, file) || !(await stat(file)).isFile()) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : new Uint8Array(await readFile(file)), {
        headers: {
          "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
          "Content-Security-Policy": EDITOR_CSP, "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
        },
      });
    } catch { return new Response("Not found", { status: 404 }); }
  });

  return {
    origin: `${DESKTOP_ORIGIN}/`,
    async close() {
      if (closed) return;
      closed = true;
      releaseRenderer();
      protocol.unhandle("mpvfx");
      ipcMain.removeHandler(DESKTOP_CHANNELS.request);
      ipcMain.removeHandler(DESKTOP_CHANNELS.subscribe);
      ipcMain.removeListener(DESKTOP_CHANNELS.cancel, cancel);
      ipcMain.removeListener(DESKTOP_CHANNELS.unsubscribe, unsubscribe);
      await runtime.close();
    },
  };
}
