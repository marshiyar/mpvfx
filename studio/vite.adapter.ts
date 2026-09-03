// Vite adapter that wires the shared Studio API to the local filesystem and build tools.

import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  realpathSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, relative, resolve, isAbsolute, dirname } from "node:path";
import type { ViteDevServer } from "vite";
import {
  type ResolvedProject,
  type RenderJobState,
  type StudioApiAdapter,
  type BackgroundRemovalRender,
  createBackgroundRemovalJob,
  createProjectSignature,
  affectsProjectSignature,
} from "@hyperframes/studio-server";
import type { RegistryItem } from "@hyperframes/core/registry";
import { fpsToNumber } from "@hyperframes/core";
import { CANVAS_DIMENSIONS } from "@hyperframes/parsers";
import { createRetryingModuleLoader, ensureProducerDist } from "./vite.producer";
import { createStudioDevRenderBodyScripts } from "./vite.studioMotion";
import {
  createNativeProjectExportMaterialization,
  nativeProjectRequiresFullRenderer,
} from "./vite.nativeProject";
import { generateThumbnail, findSystemChrome } from "./vite.browser";
import {
  buildStandaloneProducerRenderConfig,
  type StandaloneProducerRenderConfig,
} from "./vite.export-adapter";
import { createRenderCancellationRegistry } from "./vite.render-cancellation";
import {
  assertAuthoredExportWithinLimit,
  createExportStagingPaths,
  readAuthoredExportDimensions,
  resizeStandaloneExport,
  takeStandaloneExportDimensions,
} from "./vite.export-dimensions";
import { planSinglePassExportDimensions } from "./vite.export-single-pass";
import { buildStudioExportPerformanceProfile } from "./vite.export-performance-profile";
import { tryDirectMediaExport } from "./vite.direct-media-export";
import type { ExportDimensions, ExportFormat } from "./src/utils/exportPolicy";
import { render as renderBackgroundRemoval } from "./desktop/backgroundRemoval/pipeline";

function isPathWithin(parentDir: string, childPath: string): boolean {
  const childRelativePath = relative(resolve(parentDir), resolve(childPath));
  return (
    childRelativePath === "" ||
    (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath))
  );
}

export function resolveViteAutoProxy(value: string | undefined): boolean {
  return value !== "false";
}

export function resolveRenderCompositionSourcePath(
  projectDir: string,
  projectId: string,
  composition: string | undefined,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  const candidates = composition ? [composition] : ["index.html", `${projectId}.html`];
  for (const candidate of candidates) {
    const sourcePath = resolve(projectDir, candidate);
    if (!isPathWithin(projectDir, sourcePath)) return null;
    if (fileExists(sourcePath)) return sourcePath;
  }
  return null;
}

export function resolveStandaloneRenderDimensionPlan(input: {
  format: ExportFormat;
  authored: ExportDimensions | null;
  requested: ExportDimensions | null;
}): {
  resizeDimensions: ExportDimensions | null;
  outputResolution: StandaloneProducerRenderConfig["outputResolution"] | undefined;
} {
  if (!input.requested) {
    return { resizeDimensions: null, outputResolution: undefined };
  }
  if (!input.authored) {
    return { resizeDimensions: input.requested, outputResolution: undefined };
  }

  const singlePass = planSinglePassExportDimensions({
    authored: input.authored,
    requested: input.requested,
  });
  if (singlePass.resizeRequired) {
    return { resizeDimensions: input.requested, outputResolution: undefined };
  }
  // Producer supersampling is opaque-only. Matching native dimensions still
  // avoid a no-op second encode for alpha formats because no preset is needed.
  if (singlePass.outputResolution && input.format !== "mp4") {
    return { resizeDimensions: input.requested, outputResolution: undefined };
  }
  return {
    resizeDimensions: null,
    outputResolution: singlePass.outputResolution,
  };
}

/**
 * The preview ETag's cache, and the one thing allowed to clear it.
 *
 * The signature walks the whole project directory, so it is memoised per project
 * directory. (The content hash underneath is already gated behind a stat-only
 * fingerprint, so what this memo saves is the walk, not the hashing — worth
 * knowing before deciding how aggressive invalidation is allowed to be.)
 * Getting the invalidation wrong is not a
 * performance bug: the preview answers a revalidation with 304 and the browser
 * keeps serving the pre-edit composition, which is how a thumbnail regenerated
 * after an edit can still show the old frame.
 *
 * `watch` is called the first time a project dir is seen, so whoever owns the
 * watcher can start following it. It must be a watcher that actually sees
 * project writes: Vite's own is configured to ignore them.
 */
export interface ProjectSignatureCache {
  get(projectDir: string): string;
  /** Drop the signature of whichever project contains `changedPath`. */
  invalidate(changedPath: string): void;
}

export function createProjectSignatureCache({
  compute = createProjectSignature,
  watch,
}: {
  compute?: (projectDir: string) => string;
  watch?: (projectDir: string) => void;
} = {}): ProjectSignatureCache {
  const signatures = new Map<string, string>();
  const watched = new Set<string>();
  return {
    get(projectDir) {
      const key = resolve(projectDir);
      const cached = signatures.get(key);
      if (cached !== undefined) return cached;
      if (!watched.has(key)) {
        watched.add(key);
        watch?.(key);
      }
      const signature = compute(key);
      signatures.set(key, signature);
      return signature;
    },
    invalidate(changedPath) {
      // Filtered here rather than at the watcher so no caller can wire up a
      // subscription that forgets to: the cache owns what can change its value.
      for (const projectDir of signatures.keys()) {
        if (affectsProjectSignature(projectDir, changedPath)) signatures.delete(projectDir);
      }
    },
  };
}

export interface StandaloneViteAdapter extends StudioApiAdapter {
  autoProxy: boolean;
  heartbeatRender(jobId: string): boolean;
  cancelAllRenders(): void;
}

export interface StandaloneAdapterHost {
  studioDir: string;
  loadModule<T = Record<string, unknown>>(specifier: string): Promise<T>;
  renderBackgroundRemoval?: BackgroundRemovalRender;
  onClose?(listener: () => void): void;
}

export function createStandaloneAdapter(
  dataDir: string,
  host: StandaloneAdapterHost,
  signatureCache: ProjectSignatureCache,
): StandaloneViteAdapter {
  let _bundler:
    | ((
        dir: string,
        options?: { runtime?: "inline" | "placeholder"; inlineColorGradingLuts?: boolean },
      ) => Promise<string>)
    | null = null;
  const renderCancellations = createRenderCancellationRegistry();
  host.onClose?.(() => renderCancellations.dispose());
  let _producerModuleLoader:
    | (() => Promise<{
        createRenderJob: (config: StandaloneProducerRenderConfig) => unknown;
        executeRenderJob: (
          job: unknown,
          projectDir: string,
          outputPath: string,
          onProgress?: (job: { progress: number; currentStage?: string }) => void,
          signal?: AbortSignal,
        ) => Promise<void>;
      }>)
    | null = null;

  const getBundler = async () => {
    if (!_bundler) {
      try {
        const mod = await host.loadModule<typeof import("@hyperframes/core/compiler")>(
          "@hyperframes/core/compiler",
        );
        _bundler = (dir, options) => mod.bundleToSingleHtml(dir, options);
      } catch (err) {
        console.warn("[Studio] Failed to load compiler, previews will use raw HTML:", err);
        _bundler = null as never;
      }
    }
    return _bundler;
  };

  const getProducerModule = async () => {
    if (!_producerModuleLoader) {
      _producerModuleLoader = createRetryingModuleLoader(async () => {
        ensureProducerDist({ studioDir: host.studioDir });
        const producerPkg = "@hyperframes/producer";
        return await import(/* @vite-ignore */ producerPkg);
      });
    }
    return _producerModuleLoader();
  };

  return {
    // A launcher may resolve proxy settings before it starts Vite. Direct
    // `npm run dev` keeps the default-on behavior when that environment value
    // is absent.
    autoProxy: resolveViteAutoProxy(process.env.HYPERFRAMES_AUTO_PROXY),

    // fallow-ignore-next-line complexity
    listProjects() {
      if (!existsSync(dataDir)) return [];
      const sessionsDir = resolve(dataDir, "../sessions");
      const sessionMap = new Map<string, { sessionId: string; title: string }>();
      if (existsSync(sessionsDir)) {
        for (const file of readdirSync(sessionsDir).filter((f) => f.endsWith(".json"))) {
          try {
            const raw = JSON.parse(readFileSync(join(sessionsDir, file), "utf-8"));
            if (raw.projectId) {
              sessionMap.set(raw.projectId, {
                sessionId: file.replace(".json", ""),
                title: raw.title || "Untitled",
              });
            }
          } catch {
            /* skip corrupt */
          }
        }
      }
      return readdirSync(dataDir, { withFileTypes: true })
        .filter(
          (d) =>
            (d.isDirectory() || d.isSymbolicLink()) &&
            (existsSync(join(dataDir, d.name, "index.html")) ||
              existsSync(join(dataDir, d.name, `${d.name}.html`))),
        )
        .map((d) => {
          const session = sessionMap.get(d.name);
          return {
            id: d.name,
            dir: join(dataDir, d.name),
            title: session?.title ?? d.name,
            sessionId: session?.sessionId,
          } satisfies ResolvedProject;
        })
        .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
    },

    // fallow-ignore-next-line complexity
    resolveProject(id: string) {
      let projectDir = join(dataDir, id);
      if (!existsSync(projectDir)) {
        const sessionsDir = resolve(dataDir, "../sessions");
        const sessionFile = join(sessionsDir, `${id}.json`);
        if (existsSync(sessionFile)) {
          try {
            const session = JSON.parse(readFileSync(sessionFile, "utf-8"));
            if (session.projectId) {
              projectDir = join(dataDir, session.projectId);
              if (existsSync(projectDir)) {
                return {
                  id: session.projectId,
                  dir: realpathSync(projectDir),
                  title: session.title,
                };
              }
            }
          } catch {
            /* ignore */
          }
        }
        return null;
      }
      return { id, dir: realpathSync(projectDir) };
    },

    async bundle(dir: string) {
      const bundler = await getBundler();
      if (!bundler) return null;
      let html = await bundler(dir, { runtime: "placeholder", inlineColorGradingLuts: false });
      html = html.replace(
        'data-hyperframes-preview-runtime="1" src=""',
        `data-hyperframes-preview-runtime="1" src="${this.runtimeUrl}"`,
      );
      return html;
    },

    async transformPreviewHtml({ html }) {
      const producer = await import("@hyperframes/producer");
      return producer.injectDeterministicFontFaces(html);
    },

    getProjectSignature(projectDir: string): string {
      return signatureCache.get(projectDir);
    },

    async lint(html: string, opts?: { filePath?: string }) {
      const mod = await host.loadModule<typeof import("@hyperframes/core/lint")>(
        "@hyperframes/core/lint",
      );
      return await mod.lintHyperframeHtml(html, opts);
    },

    async lintProject(projectDir: string) {
      const mod = await host.loadModule<typeof import("@hyperframes/core/lint")>(
        "@hyperframes/core/lint",
      );
      return await mod.lintProject(projectDir);
    },

    runtimeUrl: "/api/runtime.js",

    rendersDir: () => resolve(dataDir, "../renders"),

    heartbeatRender(jobId) {
      return renderCancellations.heartbeat(jobId);
    },

    cancelAllRenders() {
      renderCancellations.cancelAll();
    },

    startRender(opts): RenderJobState {
      const requestedCompositionPath = resolveRenderCompositionSourcePath(
        opts.project.dir,
        opts.project.id,
        opts.composition,
      );
      let requestedCompositionSource: string | null = null;
      let authoredDimensions: ExportDimensions | null = null;
      if (requestedCompositionPath) {
        requestedCompositionSource = readFileSync(requestedCompositionPath, "utf8");
        assertAuthoredExportWithinLimit(requestedCompositionSource);
        authoredDimensions = readAuthoredExportDimensions(requestedCompositionSource);
      }
      if (existsSync(opts.outputPath)) {
        throw new Error(`Render output already exists for job "${opts.jobId}"`);
      }
      const cancellation = renderCancellations.register(opts.jobId);
      const bridgedExport = takeStandaloneExportDimensions(opts.variables);
      const dimensionPlan = resolveStandaloneRenderDimensionPlan({
        format: opts.format,
        authored: authoredDimensions,
        requested: bridgedExport.dimensions,
      });
      const directOutputDimensions =
        opts.format === "mp4" && authoredDimensions
          ? bridgedExport.dimensions ??
            (opts.outputResolution
              ? CANVAS_DIMENSIONS[opts.outputResolution]
              : authoredDimensions)
          : null;
      const staging = createExportStagingPaths(opts.outputPath, opts.jobId);
      try {
        mkdirSync(dirname(staging.directory), { recursive: true });
        mkdirSync(staging.directory);
      } catch (error) {
        cancellation.finish();
        throw error;
      }
      const producerOutputPath = dimensionPlan.resizeDimensions
        ? staging.nativeOutputPath
        : staging.encodedOutputPath;
      const state: RenderJobState = {
        id: opts.jobId,
        status: "rendering",
        progress: 0,
        outputPath: opts.outputPath,
        cancel: cancellation.cancel,
      };

      const startTime = Date.now();
      const removeCancelledOutput = () => {
        // User-initiated cancel: not a failure. Remove any output so the
        // cancelled job doesn't resurrect in the render history.
        state.status = "cancelled";
        for (const fp of [
          opts.outputPath,
          opts.outputPath.replace(/\.(mp4|webm|mov)$/, ".meta.json"),
        ]) {
          try {
            if (existsSync(fp)) unlinkSync(fp);
          } catch {
            /* ignore */
          }
        }
      };
      // fallow-ignore-next-line complexity
      (async () => {
        try {
          let rendered = false;
          let directRenderedFinalSize = false;
          if (
            !nativeProjectRequiresFullRenderer(opts.project.dir) &&
            requestedCompositionSource &&
            authoredDimensions &&
            directOutputDimensions
          ) {
            state.stage = "Checking direct media export";
            try {
              rendered = await tryDirectMediaExport({
                html: requestedCompositionSource,
                projectDir: opts.project.dir,
                outputPath: staging.encodedOutputPath,
                format: opts.format,
                fps: fpsToNumber(opts.fps),
                quality: opts.quality as "draft" | "standard" | "high",
                dimensions: authoredDimensions,
                outputDimensions: directOutputDimensions,
                signal: cancellation.signal,
                onProgress: (progress) => {
                  state.progress = progress;
                  state.stage = "Exporting media directly";
                },
              });
              directRenderedFinalSize = rendered;
            } catch (error) {
              if (cancellation.signal.aborted) throw error;
              // A failed optimization must not turn an otherwise renderable
              // project into an export failure. Remove its staging fragment
              // and continue through the complete compatibility renderer.
              try {
                if (existsSync(staging.encodedOutputPath)) {
                  unlinkSync(staging.encodedOutputPath);
                }
              } catch {
                /* partial direct-output cleanup is best-effort */
              }
              state.progress = 0;
              state.stage = "Using full composition renderer";
            }
          }

          if (!rendered) {
            if (!process.env.PRODUCER_HEADLESS_SHELL_PATH) {
              const systemChrome = findSystemChrome();
              if (systemChrome) process.env.PRODUCER_HEADLESS_SHELL_PATH = systemChrome;
            }
            const { createRenderJob, executeRenderJob } = await getProducerModule();
            if (cancellation.signal.aborted) {
              removeCancelledOutput();
              return;
            }
            const producerProjectDir = createNativeProjectExportMaterialization(
              opts.project.dir,
              join(staging.directory, "native-project"),
              staging.directory,
            );
            const renderBodyScripts = createStudioDevRenderBodyScripts(producerProjectDir);
            const producerConfig = buildStandaloneProducerRenderConfig({
              fps: opts.fps,
              quality: opts.quality as "draft" | "standard" | "high",
              format: opts.format,
              outputResolution: opts.outputResolution ?? dimensionPlan.outputResolution,
              composition: opts.composition,
              variables: bridgedExport.variables,
              renderBodyScripts,
            });
            producerConfig.producerConfig = buildStudioExportPerformanceProfile({
              extractCacheDir: resolve(dataDir, "../cache/export-frames"),
            });
            const job = createRenderJob(producerConfig);
            const onProgress = (j: { progress: number; currentStage?: string }) => {
              state.progress = dimensionPlan.resizeDimensions
                ? Math.min(90, j.progress * 0.9)
                : j.progress;
              if (j.currentStage) state.stage = j.currentStage;
            };
            await executeRenderJob(
              job,
              producerProjectDir,
              producerOutputPath,
              onProgress,
              cancellation.signal,
            );
          }
          if (cancellation.signal.aborted) {
            // Cancel landed just as the render finished: honor the cancel the
            // route already reported instead of resurrecting a completed job.
            removeCancelledOutput();
            return;
          }
          if (dimensionPlan.resizeDimensions && !directRenderedFinalSize) {
            state.stage = "Fitting output dimensions";
            state.progress = 92;
            await resizeStandaloneExport({
              format: opts.format,
              quality: opts.quality as "draft" | "standard" | "high",
              inputPath: staging.nativeOutputPath,
              outputPath: staging.encodedOutputPath,
              dimensions: dimensionPlan.resizeDimensions,
              signal: cancellation.signal,
            });
            try {
              unlinkSync(staging.nativeOutputPath);
            } catch {
              /* source cleanup is best-effort */
            }
          }
          if (cancellation.signal.aborted) {
            // Cancellation can land after FFmpeg resolves but before publish.
            // Re-check at the atomic-rename boundary so a cancelled job can
            // never appear in history as a completed export.
            removeCancelledOutput();
            return;
          }
          // Files in the public renders directory are treated as complete by
          // history. Publish only after producer/FFmpeg success, with a same-
          // filesystem rename so a partial file is never observable there.
          renameSync(staging.encodedOutputPath, opts.outputPath);
          state.status = "complete";
          state.progress = 100;
          const metaPath = opts.outputPath.replace(/\.(mp4|webm|mov)$/, ".meta.json");
          writeFileSync(
            metaPath,
            JSON.stringify({ status: "complete", durationMs: Date.now() - startTime }),
          );
        } catch (err) {
          if (cancellation.signal.aborted) {
            removeCancelledOutput();
            return;
          }
          state.status = "failed";
          state.error = err instanceof Error ? err.message : String(err);
          for (const path of [opts.outputPath]) {
            try {
              if (existsSync(path)) unlinkSync(path);
            } catch {
              /* ignore partial-output cleanup failures */
            }
          }
          try {
            const metaPath = opts.outputPath.replace(/\.(mp4|webm|mov)$/, ".meta.json");
            writeFileSync(metaPath, JSON.stringify({ status: "failed" }));
          } catch {
            /* ignore */
          }
        } finally {
          try {
            rmSync(staging.directory, { recursive: true, force: true });
          } catch {
            /* staging cleanup is best-effort */
          }
          cancellation.finish();
        }
      })();

      return state;
    },

    startBackgroundRemoval(opts) {
      return createBackgroundRemovalJob(
        opts,
        host.renderBackgroundRemoval ?? renderBackgroundRemoval,
      );
    },

    async generateThumbnail(opts) {
      return generateThumbnail(opts);
    },

    async resolveSession(sessionId: string) {
      const sessionsDir = resolve(dataDir, "../sessions");
      const sessionFile = join(sessionsDir, `${sessionId}.json`);
      if (!existsSync(sessionFile)) return null;
      try {
        const raw = JSON.parse(readFileSync(sessionFile, "utf-8"));
        if (raw.projectId) return { projectId: raw.projectId, title: raw.title };
      } catch {
        /* ignore */
      }
      return null;
    },

    // fallow-ignore-next-line complexity
    async listRegistryCatalog(): Promise<RegistryItem[]> {
      const registryRoot = resolve(host.studioDir, "../../registry");
      const items: RegistryItem[] = [];
      for (const subdir of ["blocks", "components"]) {
        const dir = join(registryRoot, subdir);
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const manifestPath = join(dir, entry.name, "registry-item.json");
          if (!existsSync(manifestPath)) continue;
          try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as RegistryItem;
            if (manifest.type === "hyperframes:block" || manifest.type === "hyperframes:component")
              items.push(manifest);
          } catch {
            /* skip malformed manifests */
          }
        }
      }
      return items;
    },

    // fallow-ignore-next-line complexity
    async installRegistryBlock(opts: {
      project: ResolvedProject;
      blockName: string;
    }): Promise<{ written: string[]; block: RegistryItem }> {
      const registryRoot = resolve(host.studioDir, "../../registry");
      let itemDir = join(registryRoot, "blocks", opts.blockName);
      if (!existsSync(join(itemDir, "registry-item.json"))) {
        itemDir = join(registryRoot, "components", opts.blockName);
      }
      const manifestPath = join(itemDir, "registry-item.json");

      if (!existsSync(manifestPath)) {
        throw new Error(`Item "${opts.blockName}" not found in registry`);
      }

      const block = JSON.parse(readFileSync(manifestPath, "utf-8")) as RegistryItem;
      const written: string[] = [];

      for (const file of block.files) {
        const sourcePath = join(itemDir, file.path);
        const targetPath = resolve(opts.project.dir, file.target);

        if (!isPathWithin(opts.project.dir, targetPath)) {
          throw new Error(`Target path escapes project directory: ${file.target}`);
        }

        mkdirSync(dirname(targetPath), { recursive: true });

        if (file.type === "hyperframes:composition") {
          let content = readFileSync(sourcePath, "utf-8");
          content = `<!-- hyperframes-registry-item: ${block.name} -->\n${content}`;
          writeFileSync(targetPath, content, "utf-8");
        } else {
          copyFileSync(sourcePath, targetPath);
        }

        written.push(file.target);
      }

      return { written, block };
    },
  };
}

/** Vite remains a development host; packaged Electron uses the same adapter directly. */
export function createViteAdapter(
  dataDir: string,
  server: ViteDevServer,
  signatureCache: ProjectSignatureCache,
): StandaloneViteAdapter {
  return createStandaloneAdapter(
    dataDir,
    {
      studioDir: __dirname,
      async loadModule<T>(specifier: string): Promise<T> {
        return (await server.ssrLoadModule(specifier)) as T;
      },
      onClose: (listener) => server.httpServer?.once("close", listener),
    },
    signatureCache,
  );
}
