import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { watch } from "chokidar";
import type { ResolvedProject } from "@hyperframes/studio-server";
import {
  createProjectSignatureCache,
  createStandaloneAdapter,
  type StandaloneAdapterHost,
  type StandaloneViteAdapter,
} from "./vite.adapter";
import { deleteStandaloneCompositionResponse } from "./vite.composition-delete";
import { createDurableWriteReceiptRegistry } from "./vite.durable-write-receipts";
import { injectStandaloneExportDimensions } from "./vite.export-dimensions";
import { validateStandaloneExportHttpRequest } from "./vite.export-request-policy";
import { ffmpegEnvironmentResponse } from "./vite.ffmpeg-status";
import { createDurableFileTransactionHttpController } from "./vite.file-transaction-http";
import { applyUploadedVideoCodecPolicy } from "./vite.media-import-codecs";
import { resolvePreviewResponseContentType } from "./vite.media-import-mime";
import { previewConfigPayload } from "./vite.preview-config";
import { readNodeRequestBody } from "./vite.request-body";
import { matchRenderHeartbeatRequest } from "./vite.render-heartbeat";
import { stabilizeStandalonePreviewRuntime } from "./vite.runtime-audio-stability";
import { ensureStandaloneProject } from "./vite.standalone-project";

interface StudioServerModule {
  createStudioApi(adapter: StandaloneViteAdapter): {
    fetch(request: Request): Promise<Response>;
  };
  consumeFileWriteReceipt?(
    path: string,
    expectedVersion: string,
  ): { path: string; version: string; writeToken: string } | null;
  fileContentVersion?(content: string): string;
}

export interface StudioHttpServiceOptions {
  projectsDir: string;
  version: string;
  adapterHost: StandaloneAdapterHost;
  environment?: NodeJS.ProcessEnv;
  processId?: number;
  onFileChange?(data: { path: string; version?: string; writeToken?: string }): void;
  loadRuntimeSource?: () => string | null;
}

export interface StudioHttpService {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
}

function installedRuntimeSource(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return stabilizeStandalonePreviewRuntime(
      readFileSync(require.resolve("@hyperframes/core/runtime"), "utf8"),
    );
  } catch (error) {
    console.warn("[Studio] Failed to load the installed preview runtime:", error);
    return null;
  }
}

function installedMotionPathPluginSource(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return readFileSync(require.resolve("gsap/dist/MotionPathPlugin.min.js"), "utf8");
  } catch (error) {
    console.warn("[Studio] Failed to load the installed MotionPath plugin:", error);
    return null;
  }
}

export async function bridgeFetchResponse(
  fetchResponse: Response,
  response: ServerResponse,
  requestPath: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  fetchResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const contentType = resolvePreviewResponseContentType(requestPath, headers["content-type"]);
  if (contentType) headers["content-type"] = contentType;
  response.writeHead(fetchResponse.status, headers);
  if (!fetchResponse.body) {
    response.end();
    return;
  }

  const reader = fetchResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(value)) {
        await new Promise<void>((resolve) => response.once("drain", resolve));
      }
    }
  } catch {
    // The renderer may seek away while a media response is still streaming.
  } finally {
    response.end();
  }
}

function projectDirectories(projectsDir: string): string[] {
  try {
    return readdirSync(projectsDir, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = join(projectsDir, entry.name);
      try {
        return [lstatSync(fullPath).isSymbolicLink() ? realpathSync(fullPath) : fullPath];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function shouldPublishFileChange(filePath: string): boolean {
  if (filePath.includes(`${sep}.hyperframes${sep}studio-transactions${sep}`)) return false;
  return /\.(?:html|css|js|json)$/i.test(filePath);
}

export function createStudioHttpService(options: StudioHttpServiceOptions): StudioHttpService {
  ensureStandaloneProject(options.projectsDir);
  const closeListeners = new Set<() => void>();
  const adapterHost: StandaloneAdapterHost = {
    ...options.adapterHost,
    onClose: (listener) => {
      closeListeners.add(listener);
      options.adapterHost.onClose?.(listener);
    },
  };
  const projectWatcher = watch(projectDirectories(options.projectsDir), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 10 },
  });
  const projectWatcherReady = new Promise<void>((resolveReady) => {
    projectWatcher.once("ready", resolveReady);
  });
  const signatureCache = createProjectSignatureCache({
    watch: (projectDir) => void projectWatcher.add(projectDir),
  });
  const durableWriteReceipts = createDurableWriteReceiptRegistry();
  for (const event of ["add", "change", "unlink", "addDir", "unlinkDir"] as const) {
    projectWatcher.on(event, (filePath: string) => signatureCache.invalidate(filePath));
  }

  const adapter = createStandaloneAdapter(options.projectsDir, adapterHost, signatureCache);
  let studioModule: StudioServerModule | null = null;
  let api: { fetch(request: Request): Promise<Response> } | null = null;
  const getApi = async () => {
    if (!api) {
      studioModule = await options.adapterHost.loadModule<StudioServerModule>(
        "@hyperframes/studio-server",
      );
      api = studioModule.createStudioApi(adapter);
    }
    return api;
  };
  const durableTransactions = createDurableFileTransactionHttpController({
    resolveProject: async (projectId) => {
      await getApi();
      return (await adapter.resolveProject(projectId)) ?? null;
    },
  });
  const eventClients = new Set<ServerResponse>();
  let closed = false;

  const publishFileChange = (filePath: string) => {
    if (!shouldPublishFileChange(filePath)) return;
    let version: string | null = null;
    let content: string | null = null;
    try {
      content = readFileSync(filePath, "utf8");
      version = studioModule?.fileContentVersion?.(content) ?? null;
    } catch {
      // Deleted files have no bytes to match against a write receipt.
    }
    const receipt =
      version && content !== null
        ? durableWriteReceipts.consume(filePath, content, version) ??
          (studioModule?.consumeFileWriteReceipt?.(filePath, version) ?? null)
        : null;
    const data = receipt ?? { path: filePath };
    options.onFileChange?.(data);
    const event = `event: file-change\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of eventClients) client.write(event);
  };
  for (const event of ["add", "change", "unlink"] as const) {
    projectWatcher.on(event, publishFileChange);
  }

  const registerEventClient = (request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(": connected\n\n");
    eventClients.add(response);
    request.once("close", () => eventClients.delete(response));
  };

  const handleApi = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    url.pathname = url.pathname.slice(4);
    const recoveryFailure = await durableTransactions.ensureRecoveredForProjectPath(url.pathname);
    if (recoveryFailure) {
      await bridgeFetchResponse(recoveryFailure, response, url.pathname);
      return;
    }
    const heartbeatJobId = matchRenderHeartbeatRequest(request.method, url.pathname);
    if (heartbeatJobId) {
      const alive = adapter.heartbeatRender(heartbeatJobId);
      response.writeHead(alive ? 200 : 404, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(alive ? { ok: true } : { error: "Render not active" }));
      return;
    }

    let body: Buffer | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const bytes = await readNodeRequestBody(request);
      body = bytes.byteLength > 0 ? bytes : undefined;
    }
    const durableTransactionResponse = await durableTransactions.handle({
      method: request.method,
      pathname: url.pathname,
      body,
    });
    if (durableTransactionResponse) {
      if (
        durableTransactionResponse.ok &&
        request.method === "POST" &&
        /^\/projects\/[^/]+\/file-transactions\/commit$/.test(url.pathname) &&
        body
      ) {
        try {
          const projectId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
          const project = await adapter.resolveProject(projectId);
          const payload = JSON.parse(body.toString("utf8")) as {
            files?: Array<{ path: string; after: string | null }>;
            writeTokens?: Record<string, string>;
          };
          if (project && Array.isArray(payload.files) && payload.writeTokens) {
            durableWriteReceipts.register({
              projectRoot: project.dir,
              files: payload.files,
              writeTokens: payload.writeTokens,
            });
          }
        } catch {
          // The journal commit already succeeded; watcher metadata is best effort.
        }
      }
      await bridgeFetchResponse(durableTransactionResponse, response, url.pathname);
      return;
    }

    const ffmpegResponse = ffmpegEnvironmentResponse(url.pathname, request.method);
    if (ffmpegResponse) {
      await bridgeFetchResponse(ffmpegResponse, response, url.pathname);
      return;
    }
    const exportValidation = validateStandaloneExportHttpRequest({
      method: request.method,
      requestPath: url.pathname,
      body,
    });
    if (exportValidation) {
      await bridgeFetchResponse(exportValidation, response, url.pathname);
      return;
    }
    const originalBody = body;
    if (request.method === "POST" && /^\/projects\/[^/]+\/render$/.test(url.pathname)) {
      body = injectStandaloneExportDimensions(body);
    }

    if (url.pathname.includes("/file-mutations/delete-composition/")) {
      await getApi();
      const versionOf = studioModule?.fileContentVersion;
      if (!versionOf) {
        await bridgeFetchResponse(
          Response.json({ error: "Composition version service is unavailable" }, { status: 503 }),
          response,
          url.pathname,
        );
        return;
      }
      const deletion = await deleteStandaloneCompositionResponse({
        method: request.method,
        pathname: url.pathname,
        body,
        resolveProject: async (projectId): Promise<ResolvedProject | null> =>
          (await adapter.resolveProject(projectId)) ?? null,
        versionOf,
      });
      if (deletion) {
        await bridgeFetchResponse(deletion, response, url.pathname);
        return;
      }
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    if (body !== originalBody) delete headers["content-length"];
    const fetchRequest = new Request(url.toString(), {
      method: request.method,
      headers,
      body: body ? new Uint8Array(body) : undefined,
    });
    const fetchResponse = await (await getApi()).fetch(fetchRequest);
    const filtered = await applyUploadedVideoCodecPolicy({
      requestPath: url.pathname,
      response: fetchResponse,
      resolveProject: async (projectId) => (await adapter.resolveProject(projectId)) ?? null,
    });
    await bridgeFetchResponse(filtered, response, url.pathname);
  };

  return {
    async handle(request, response) {
      const requestUrl = request.url;
      if (!requestUrl) return false;
      const url = new URL(requestUrl, `http://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname === "/api/events") {
        // Do not acknowledge the event stream until chokidar has finished its
        // initial scan. Otherwise a client can receive `: connected`, write a
        // project file immediately, and lose that change before the watcher is
        // actually listening (most visible on slower CI and fresh installs).
        await projectWatcherReady;
        registerEventClient(request, response);
        return true;
      }
      if (url.pathname === "/__hyperframes_config") {
        const payload = previewConfigPayload(
          options.environment ?? process.env,
          options.processId ?? process.pid,
          options.version,
        );
        if (!payload) return false;
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify(payload));
        return true;
      }
      if (url.pathname === "/api/runtime.js") {
        const source = (options.loadRuntimeSource ?? installedRuntimeSource)();
        if (!source) {
          response.writeHead(404);
          response.end("runtime not available");
        } else {
          response.writeHead(200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end(source);
        }
        return true;
      }
      if (url.pathname === "/api/motion-path-plugin.js") {
        const source = installedMotionPathPluginSource();
        if (!source) {
          response.writeHead(404);
          response.end("motion path plugin not available");
        } else {
          response.writeHead(200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          response.end(source);
        }
        return true;
      }
      if (!url.pathname.startsWith("/api/")) return false;
      try {
        await handleApi(request, response, url);
      } catch (error) {
        console.error("[Studio API] Error:", error);
        if (!response.headersSent) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Internal server error" }));
        } else if (!response.writableEnded) {
          response.end();
        }
      }
      return true;
    },
    async close() {
      if (closed) return;
      closed = true;
      adapter.cancelAllRenders();
      for (const listener of closeListeners) listener();
      for (const client of eventClients) client.end();
      eventClients.clear();
      await projectWatcher.close();
    },
  };
}
