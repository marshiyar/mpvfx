import { LibraryService } from "../runtime/index";
import { dispatchLibraryCommand } from "./libraryCommands";
import { launchCrosspost, resolveCrosspostRender } from "./crosspostCommands";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ipcMain, protocol, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import { createStudioRuntime } from "../runtime/index";
import { DESKTOP_CHANNELS, DESKTOP_ORIGIN, type DesktopRequest, type DesktopResponse } from "../shared/desktopBridge";
import { projectIdFromPreviewHost } from "../shared/desktopPreviewOrigin";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon",
  ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm",
};
const EDITOR_CSP = [
  "default-src 'self' blob: data:", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'", "frame-src mpvfx://*.preview blob:", "worker-src 'self' blob:",
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
      !parsed.username && !parsed.password && !parsed.port && parsed.pathname === "/";
  } catch { return false; }
}

const SHARED_PREVIEW_PATHS = new Set(["/api/runtime.js", "/api/motion-path-plugin.js", "/api/fonts/file"]);
const EDITOR_RESOURCE_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";

export function isEditorResourcePath(path: string): boolean {
  return /^\/api\/projects\/[^/]+\/(?:preview|thumbnail|waveform)(?:\/|$)/.test(path) ||
    /^\/api\/projects\/[^/]+\/renders\/file\/[^?#]+\.(?:mp4|webm|mov)$/i.test(path) ||
    /^\/api\/render\/[^/]+\/(?:view|download)$/.test(path);
}

export function isPreviewResourcePath(path: string, projectId: string): boolean {
  if (SHARED_PREVIEW_PATHS.has(path)) return true;
  const match = /^\/api\/projects\/([^/]+)\/preview(?:\/|$)/.exec(path);
  if (!match) return false;
  try {
    return match[1] === encodeURIComponent(projectId) && decodeURIComponent(match[1]) === projectId;
  } catch { return false; }
}

function protectEditorResource(response: Response, path: string): Response {
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const safeTypes = new Set([
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp",
    "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/mxf", "video/mp2t",
    "audio/mpeg", "audio/mp4", "audio/wav", "audio/wave", "audio/x-wav", "audio/ogg", "audio/flac", "audio/aac",
    "font/woff", "font/woff2", "font/ttf", "font/otf", "font/collection",
    "application/font-woff", "application/vnd.ms-fontobject", "application/json",
  ]);
  // Older project markup can contain absolute editor-origin media URLs. Keep
  // only passive media there; authored HTML, SVG, CSS and scripts belong to the
  // project preview origin even when embedded as a nested frame.
  if (response.ok && (!safeTypes.has(type ?? "") ||
      (/^\/api\/projects\/[^/]+\/preview(?:\/|$)/.test(path) && type === "application/json"))) {
    return new Response(null, { status: 403 });
  }
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", EDITOR_RESOURCE_CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

interface Options {
  crosspostDir?: string;
  libraryModulePath?: string;
  userDataPath?: string;
  staticDir: string;
  projectsDir: string;
  studioDir: string;
  editorContents(): WebContents | undefined;
}

/** Owns native commands, subscriptions and packaged resources. Opens no network listener. */
export async function startEditorRuntime(options: Options) {
  const libraries = options.libraryModulePath && options.userDataPath
    ? new LibraryService(options.userDataPath, options.libraryModulePath) : undefined;
  await libraries?.restore();
  const runtime = createStudioRuntime({
    libraries,
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
  ipcMain.handle(DESKTOP_CHANNELS.crosspost, async (event, projectId: string, filename: string) => {
    assertEditor(event);
    if (!options.crosspostDir || !options.userDataPath) throw new Error("Publishing is unavailable");
    if (typeof projectId !== "string" || !projectId || /[/\\\x00-\x1f]/.test(projectId)) throw new Error("Invalid project");
    await runtime.withProject(projectId, async () => {
      const root = libraries?.outputDirectory(projectId) ?? resolve(options.projectsDir, "../renders");
      const file = await resolveCrosspostRender(root, filename);
      await launchCrosspost(options.crosspostDir!, options.userDataPath!, file);
    });
  });
  ipcMain.handle(DESKTOP_CHANNELS.library, async (event, command) => {
    assertEditor(event);
    if (!libraries) throw new Error("Library service is unavailable");
    return dispatchLibraryCommand(libraries, runtime, command);
  });
  ipcMain.handle(DESKTOP_CHANNELS.importFiles, async (event, projectId: string, paths: string[], directory?: string) => {
    assertEditor(event);
    if (typeof projectId !== "string" || !projectId || /[/\\\x00-\x1f]/.test(projectId) ||
        !Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== "string" || !isAbsolute(path)) ||
        (directory !== undefined && typeof directory !== "string")) throw new Error("Invalid media import");
    return runtime.importFiles(projectId, paths, directory);
  });
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
    if (closed || url.username || url.password || url.port) return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    const previewProject = projectIdFromPreviewHost(url.host);
    if (previewProject !== null) {
      return isPreviewResourcePath(url.pathname, previewProject)
        ? runtime.handle(request) : new Response(null, { status: 403 });
    }
    if (url.host !== "editor") return new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/api/")) {
      return isEditorResourcePath(url.pathname)
        ? protectEditorResource(await runtime.handle(request), url.pathname) : new Response(null, { status: 403 });
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
      ipcMain.removeHandler(DESKTOP_CHANNELS.crosspost);
      ipcMain.removeHandler(DESKTOP_CHANNELS.library);
      ipcMain.removeHandler(DESKTOP_CHANNELS.importFiles);
      ipcMain.removeHandler(DESKTOP_CHANNELS.subscribe);
      ipcMain.removeListener(DESKTOP_CHANNELS.cancel, cancel);
      ipcMain.removeListener(DESKTOP_CHANNELS.unsubscribe, unsubscribe);
      await runtime.close();
      await libraries?.close();
    },
  };
}
