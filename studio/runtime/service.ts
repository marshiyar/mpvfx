import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { watch } from "chokidar";
import type { ResolvedProject } from "@hyperframes/studio-server";
import {
  createProjectSignatureCache,
  createStandaloneAdapter,
  type StudioServerHost,
  type StudioServerAdapter,
} from "./adapter";
import { deleteStandaloneCompositionResponse } from "./projects/compositionDelete";
import { projectFileChangeScope, projectMediaChangeScope, createFileChangeVersionFilter, createDurableWriteReceiptRegistry } from "./projects/durableWriteReceipts";
import { injectStandaloneExportDimensions } from "./export/dimensions";
import { validateStandaloneExportHttpRequest } from "./export/requestPolicy";
import { ffmpegEnvironmentResponse } from "./media/ffmpegStatus";
import { createDurableFileTransactionHttpController } from "./projects/fileTransactionHttp";
import { mediaFileOperationResponse } from "./projects/mediaFileOperations";
import { applyUploadedVideoCodecPolicy } from "./media/importCodecs";
import { resolvePreviewResponseContentType } from "./media/importMime";
import { matchRenderHeartbeatRequest } from "./export/heartbeat";
import { coordinateNativePreviewRuntime } from "./preview/nativePicture";
import { stabilizeStandalonePreviewRuntime } from "./preview/audioStability";
import { synchronizeStandaloneTransportDuration } from "./preview/transportDuration";
import { enableStandaloneLutUrls } from "./preview/lutUrls";
import { ensureStandaloneProject } from "./projects/standaloneProject";
import { createProjectAccessQueue } from "./projects/projectAccess";
import { decodeNativeVideoFrames } from "./media/videoFrames";
import type { VideoFramesRequest } from "../shared/desktopBridge";

interface StudioServerModule {
  createStudioApi(adapter: StudioServerAdapter): {
    fetch(request: Request): Promise<Response>;
  };
  consumeFileWriteReceipt?(
    path: string,
    expectedVersion: string,
  ): { path: string; version: string; writeToken: string } | null;
  fileContentVersion?(content: string): string;
}

export interface StudioRuntimeOptions {
  projectsDir: string;
  adapterHost: StudioServerHost;
  onFileChange?(data: { projectId?: string; path: string; kind?: "media"; version?: string | null; writeToken?: string }): void;
  loadRuntimeSource?: () => string | null;
}

export interface RuntimeEvent { type: string; data: string }

export interface StudioRuntime {
  handle(request: Request): Promise<Response>;
  subscribe(path: string, listener: (event: RuntimeEvent) => void): Promise<() => void>;
  close(): Promise<void>;
}

function installedRuntimeSource(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return coordinateNativePreviewRuntime(stabilizeStandalonePreviewRuntime(synchronizeStandaloneTransportDuration(
      enableStandaloneLutUrls(readFileSync(require.resolve("@hyperframes/core/runtime"), "utf8")),
    )));
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

function projectDirectories(projectsDir: string): Array<{ id: string; dir: string }> {
  try {
    return readdirSync(projectsDir, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = join(projectsDir, entry.name);
      try {
        const dir = realpathSync(fullPath);
        return lstatSync(dir).isDirectory() ? [{ id: entry.name, dir }] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function createStudioRuntime(options: StudioRuntimeOptions): StudioRuntime {
  ensureStandaloneProject(options.projectsDir);
  const closeListeners = new Set<() => void>();
  const adapterHost: StudioServerHost = {
    ...options.adapterHost,
    onClose: (listener) => {
      closeListeners.add(listener);
      options.adapterHost.onClose?.(listener);
    },
  };
  const projectRoots = new Map(projectDirectories(options.projectsDir).map((project) => [project.id, project.dir]));
  const projectWatcher = watch([...projectRoots.values()], {
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
  const projectAccess = createProjectAccessQueue();
  const inProject = async <T>(projectId: string, operation: () => Promise<T>): Promise<T> => {
    const project = await adapter.resolveProject(projectId);
    if (!project) return operation();
    const root = realpathSync(project.dir);
    projectRoots.set(projectId, root);
    return projectAccess.run(root, operation);
  };
  let studioModule: StudioServerModule | null = null;
  // Keep the dependency's file/media operations in-process. This dispatcher
  // consumes Request/Response values; it does not make HTTP calls or listen on a port.
  let apiPromise: Promise<ReturnType<StudioServerModule["createStudioApi"]>> | null = null;
  const getApi = () => {
    apiPromise ??= options.adapterHost.loadModule<StudioServerModule>("@hyperframes/studio-server")
      .then((module) => {
        studioModule = module;
        return module.createStudioApi(adapter);
      }).catch((error) => { apiPromise = null; throw error; });
    return apiPromise;
  };
  const durableTransactions = createDurableFileTransactionHttpController({
    resolveProject: async (projectId) => {
      await getApi();
      return (await adapter.resolveProject(projectId)) ?? null;
    },
  });
  const fileListeners = new Set<(event: RuntimeEvent) => void>();
  const subscriptions = new Set<() => void>();
  const renderJobs = new Map<string, ReturnType<StudioServerAdapter["startRender"]>>();
  const startRender = adapter.startRender.bind(adapter);
  adapter.startRender = (options) => {
    for (const [id, previous] of renderJobs) {
      if (previous.status !== "rendering") renderJobs.delete(id);
    }
    const job = startRender(options);
    renderJobs.set(options.jobId, job);
    return job;
  };
  let closed = false;

  const isNewFileVersion = createFileChangeVersionFilter();
  const publishFileChange = async (filePath: string) => {
    // Watchers report the real location of linked projects. Translate back to
    // every project identity through which that source is open in the editor.
    const paths = new Set<string>([resolve(filePath)]);
    for (const [id, root] of projectRoots) {
      const offset = relative(root, resolve(filePath));
      if (!offset || isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`)) continue;
      paths.add(join(options.projectsDir, id, offset));
    }
    let sharedReceipt: ReturnType<typeof durableWriteReceipts.consume> = null;
    for (const scopedPath of paths) {
      const mediaScope = projectMediaChangeScope(options.projectsDir, scopedPath);
      const scope = mediaScope ?? projectFileChangeScope(options.projectsDir, scopedPath);
      if (!scope) continue;
      await inProject(scope.projectId, async () => {
        if (closed) return;
        let version: string | null = null;
        let content: string | null = null;
        try {
          if (mediaScope) {
            // Source revision, not an asset ID. Avoid reading a video as UTF-8 or
            // hashing gigabytes merely to invalidate a cached frame.
            const info = lstatSync(filePath, { bigint: true });
            if (!info.isFile() || info.isSymbolicLink()) return;
            version = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
          } else {
            content = readFileSync(filePath, "utf8");
            version = studioModule?.fileContentVersion?.(content) ?? null;
          }
        } catch {
          // Deleted files have no bytes to match against a write receipt.
        }
        if (!isNewFileVersion(scopedPath, version)) return;
        const receipt =
          version && content !== null
            ? sharedReceipt ?? durableWriteReceipts.consume(filePath, content, version) ??
              (studioModule?.consumeFileWriteReceipt?.(filePath, version) ?? null)
            : null;
        sharedReceipt = receipt;
        const data = { ...receipt, ...scope, ...(mediaScope || version ? { version } : {}) };
        options.onFileChange?.(data);
        for (const listener of fileListeners) listener({ type: "file-change", data: JSON.stringify(data) });
      });
    }
  };
  for (const event of ["add", "change", "unlink"] as const) {
    projectWatcher.on(event, (path) => {
      void publishFileChange(path).catch((error) => console.error("[MpVFX file watcher]", error));
    });
  }

  const handleApi = async (request: Request, url: URL): Promise<Response> => {
    url.pathname = url.pathname.slice(4);
    const framesRoute = /^\/projects\/([^/]+)\/media\/frames$/.exec(url.pathname);
    if (framesRoute && request.method === "POST") {
      const project = await adapter.resolveProject(decodeURIComponent(framesRoute[1]));
      if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
      const frameRequest = await request.json() as VideoFramesRequest;
      if (frameRequest?.location !== undefined && frameRequest.location !== "project" && frameRequest.location !== "render") {
        return Response.json({ error: "Invalid media location" }, { status: 400 });
      }
      return Response.json(await decodeNativeVideoFrames(
        frameRequest?.location === "render" ? adapter.rendersDir(project) : project.dir,
        frameRequest, request.signal,
      ));
    }
    // The upstream API includes agent context storage. It is not part of the
    // desktop editor; keep it out of the native command interface.
    if (/^\/projects\/[^/]+\/selection\/?$/.test(url.pathname)) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const recoveryFailure = await durableTransactions.ensureRecoveredForProjectPath(url.pathname);
    if (recoveryFailure) {
      return recoveryFailure;
    }
    const heartbeatJobId = matchRenderHeartbeatRequest(request.method, url.pathname);
    if (heartbeatJobId) {
      const alive = adapter.heartbeatRender(heartbeatJobId);
      return Response.json(alive ? { ok: true } : { error: "Render not active" }, { status: alive ? 200 : 404 });
    }

    let body: Buffer | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const bytes = Buffer.from(await request.arrayBuffer());
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
      return durableTransactionResponse;
    }

    const mediaOperation = await mediaFileOperationResponse({
      method: request.method, pathname: url.pathname, body,
      resolveProject: async (projectId) => (await adapter.resolveProject(projectId)) ?? null,
      transactions: durableTransactions,
    });
    if (mediaOperation) {
      if (mediaOperation.ok && body) {
        const payload = JSON.parse(body.toString("utf8"));
        const result = await mediaOperation.clone().json();
        const project = await adapter.resolveProject(decodeURIComponent(url.pathname.split("/")[2]));
        if (project && result.receipt?.files && payload.writeTokens) {
          durableWriteReceipts.register({ projectRoot: project.dir, files: result.receipt.files, writeTokens: payload.writeTokens });
        }
      }
      return mediaOperation;
    }

    const ffmpegResponse = ffmpegEnvironmentResponse(url.pathname, request.method);
    if (ffmpegResponse) {
      return ffmpegResponse;
    }
    const exportValidation = validateStandaloneExportHttpRequest({
      method: request.method,
      requestPath: url.pathname,
      body,
    });
    if (exportValidation) {
      return exportValidation;
    }
    const originalBody = body;
    if (request.method === "POST" && /^\/projects\/[^/]+\/render$/.test(url.pathname)) {
      body = injectStandaloneExportDimensions(body);
    }

    if (url.pathname.includes("/file-mutations/delete-composition/")) {
      await getApi();
      const versionOf = studioModule?.fileContentVersion;
      if (!versionOf) {
        return Response.json({ error: "Composition version service is unavailable" }, { status: 503 });
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
        return deletion;
      }
    }

    const headers = new Headers(request.headers);
    if (body !== originalBody) headers.delete("content-length");
    const fetchRequest = new Request(url.toString(), {
      method: request.method,
      signal: request.signal,
      headers,
      body: body ? new Uint8Array(body) : undefined,
    });
    const fetchResponse = await (await getApi()).fetch(fetchRequest);
    const filtered = await applyUploadedVideoCodecPolicy({
      requestPath: url.pathname,
      response: fetchResponse,
      resolveProject: async (projectId) => (await adapter.resolveProject(projectId)) ?? null,
    });
    const contentType = resolvePreviewResponseContentType(url.pathname, filtered.headers.get("content-type") ?? undefined);
    if (contentType) filtered.headers.set("content-type", contentType);
    if (/^\/projects\/[^/]+\/(?:preview|waveform)(?:\/|$)/.test(url.pathname)) {
      filtered.headers.set("cache-control", "no-store");
    }
    return filtered;
  };

  const handle = async (request: Request): Promise<Response> => {
    if (closed) return Response.json({ error: "Runtime is closed" }, { status: 503 });
    const url = new URL(request.url);
    if (url.pathname === "/api/runtime.js" || url.pathname === "/api/motion-path-plugin.js") {
      const source = url.pathname === "/api/runtime.js"
        ? (options.loadRuntimeSource ?? installedRuntimeSource)()
        : installedMotionPathPluginSource();
      return new Response(source ?? "Runtime not available", {
        status: source ? 200 : 404,
        headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (!url.pathname.startsWith("/api/") || url.pathname === "/api/events" || url.pathname.endsWith("/progress")) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const projectRoute = /^\/api\/projects\/([^/]+)(?:\/([^/]+))?/.exec(url.pathname);
      const mutatesSource = !["GET", "HEAD"].includes(request.method) &&
        /^\/api\/projects\/[^/]+\/(?:files|file-mutations|gsap-mutations|gsap-mutations-batch|gsap-mutation-rollback|duplicate-file|upload|registry\/install|file-transactions\/commit)(?:\/|$)/.test(url.pathname) &&
        !/^\/api\/projects\/[^/]+\/file-mutations\/probe-element\//.test(url.pathname);
      const dispatch = async () => {
        request.signal.throwIfAborted();
        try { return await handleApi(request, url); }
        finally {
          // A following read must see the save immediately, even before chokidar
          // delivers its delayed event. Failed writes may also have recovered.
          if (projectRoute && mutatesSource) {
            const project = await adapter.resolveProject(decodeURIComponent(projectRoute[1]));
            if (project) signatureCache.invalidateProject(project.dir);
          }
        }
      };
      // Thumbnail capture re-enters handle() to read its preview and resources.
      // It owns only generated cache files, so must not hold the source lock.
      if (projectRoute && projectRoute[2] !== "thumbnail" && projectRoute[2] !== "waveform" &&
          !/^\/api\/projects\/[^/]+\/media\/frames$/.test(url.pathname)) {
        return await inProject(decodeURIComponent(projectRoute[1]), dispatch);
      }
      return await dispatch();
    } catch (error) {
      if (request.signal.aborted) throw error;
      console.error("[MpVFX runtime]", error);
      return Response.json({ error: "Operation failed" }, { status: 500 });
    }
  };

  // Chromium used for thumbnails receives resources directly, without a server.
  adapter.generateThumbnail = async (options) => {
    const { generateThumbnail } = await import("./preview/browser");
    return generateThumbnail({ ...options, readResource: handle });
  };

  return {
    handle,
    async subscribe(path, listener) {
      if (closed) throw new Error("Runtime is closed");
      if (path === "/api/events") {
        await projectWatcherReady;
        if (closed) throw new Error("Runtime is closed");
        fileListeners.add(listener);
        return () => { fileListeners.delete(listener); };
      }
      const match = /^\/api\/render\/([^/]+)\/progress$/.exec(path);
      const id = match ? decodeURIComponent(match[1]) : "";
      const job = renderJobs.get(id);
      if (!job) throw new Error("Render not found");
      const stop = () => {
        clearInterval(timer);
        subscriptions.delete(stop);
        if (job.status !== "rendering") renderJobs.delete(id);
      };
      const publish = () => {
        listener({ type: "progress", data: JSON.stringify({
          progress: job.progress, status: job.status, stage: job.stage, error: job.error,
        }) });
        if (job.status !== "rendering") stop();
      };
      const timer = setInterval(publish, 500);
      subscriptions.add(stop);
      publish();
      return stop;
    },
    async close() {
      if (closed) return;
      closed = true;
      await projectAccess.drain();
      adapter.cancelAllRenders();
      for (const listener of closeListeners) listener();
      for (const stop of subscriptions) stop();
      subscriptions.clear();
      fileListeners.clear();
      renderJobs.clear();
      await projectWatcher.close();
    },
  };
}
