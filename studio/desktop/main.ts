import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { app, BrowserWindow, dialog, protocol, session } from "electron";
import { createDesktopAppController, shouldQuitWhenAllWindowsClosed } from "./appLifecycle";
import { resolveInstalledMediaBinaryPaths } from "./installedMediaBinaries";
import { ensureDesktopProject, resolveDesktopDataPaths } from "./projectPaths";
import { prepareEditorRendererSession } from "./rendererCache";
import { applyDesktopRuntimeEnvironment } from "./runtimeBinaries";
import { createWindowOptions, installWindowGuards, isEditorFullscreenRequest } from "./windowPolicy";
import { installEngineInMainProcess, resolveEngineModulePath } from "./engineModule";
import { assertBundledMediaBinariesAvailable } from "../runtime/environment";
import { flushRendererSaves } from "./rendererSaveBarrier";

protocol.registerSchemesAsPrivileged([{
  scheme: "mpvfx",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

const integrationBundle = app.isPackaged && existsSync(join(process.resourcesPath, "mpvfx-integration-profile"));
app.setName(integrationBundle ? "MpVFX Integration Preview" : "MpVFX");
app.setAppUserModelId(integrationBundle ? "com.mpvfx.editor.integration-preview" : "com.mpvfx.editor");
// Tests and portable launches must isolate Chromium storage as well as project
// files. Otherwise a disposable project root can restore the user's recent
// library from the default session's localStorage.
if (process.env.MPVFX_USER_DATA_DIR) {
  const isolatedDataPath = resolve(process.env.MPVFX_USER_DATA_DIR);
  mkdirSync(isolatedDataPath, { recursive: true });
  app.setPath("userData", isolatedDataPath);
} else if (integrationBundle) {
  const isolatedDataPath = join(app.getPath("appData"), "MpVFX Integration Preview");
  mkdirSync(isolatedDataPath, { recursive: true });
  app.setPath("userData", isolatedDataPath);
}

let mainWindow: BrowserWindow | null = null;
let quittingAfterCleanup = false;
let quitInProgress = false;
let controller: ReturnType<typeof createDesktopAppController> | null = null;
let engineModulePath: string | undefined;

function configurePermissions(): void {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    return webContents === mainWindow?.webContents &&
      isEditorFullscreenRequest(permission, details, controller?.origin());
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(webContents === mainWindow?.webContents &&
      isEditorFullscreenRequest(permission, details, controller?.origin()));
  });
}

function createEditorWindow(): BrowserWindow {
  const editorWindow = new BrowserWindow(createWindowOptions(
    join(app.getAppPath(), ".build", "desktop-dist", "preload", "preload.cjs"),
    engineModulePath,
  ));
  mainWindow = editorWindow;
  editorWindow.setMenu(null);
  if (process.env.MPVFX_HIDDEN_TEST_WINDOW !== "1") {
    editorWindow.once("ready-to-show", () => editorWindow.show());
  }
  let closeApproved = false;
  let closeInProgress = false;
  editorWindow.on("close", event => {
    if (closeApproved) return;
    event.preventDefault();
    if (closeInProgress || quitInProgress) return;
    closeInProgress = true;
    void flushRendererSaves(editorWindow).then(() => {
      closeApproved = true;
      if (!editorWindow.isDestroyed()) editorWindow.close();
    }).catch(error => {
      closeInProgress = false;
      dialog.showErrorBox("MpVFX could not finish saving", error instanceof Error ? error.message : String(error));
    });
  });
  editorWindow.on("closed", () => {
    if (mainWindow === editorWindow) mainWindow = null;
    controller?.forgetWindow();
  });
  editorWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const origin = controller?.origin();
  if (!origin) throw new Error("Desktop editor origin is unavailable");
  installWindowGuards(editorWindow.webContents, origin);
  return editorWindow;
}

async function startDesktopApplication(): Promise<void> {
  configurePermissions();
  const appPath = app.getAppPath();
  // The C++ engine owns keyframes; nothing that evaluates them may start first.
  engineModulePath = resolveEngineModulePath({ appPath, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  installEngineInMainProcess(engineModulePath);
  // Export pages run the preview's frame-application code from this bundle.
  process.env.MPVFX_NATIVE_FRAME_RUNTIME = join(appPath, ".build", "runtime", "native-export-frame-runtime.js");
  const userDataPath = process.env.MPVFX_USER_DATA_DIR
    ? resolve(process.env.MPVFX_USER_DATA_DIR)
    : app.getPath("userData");
  const paths = resolveDesktopDataPaths(userDataPath, process.platform);
  ensureDesktopProject(paths);
  const mediaBinaries = resolveInstalledMediaBinaryPaths();
  applyDesktopRuntimeEnvironment({
    current: process.env,
    ...mediaBinaries,
    browserCacheDir: app.isPackaged ? process.resourcesPath : join(appPath, ".puppeteer-cache"),
  });
  assertBundledMediaBinariesAvailable();

  // Load the runtime/render graph only after the packaged paths exist. Several
  // upstream packages cache FFmpeg-family discovery at module scope; a static
  // import here allowed that graph to observe a stale shell override before the
  // desktop runtime replaced it with this build's bundled executables.
  const { startEditorRuntime } = await import("./editorRuntime");
  const { closeSharedBrowser } = await import("../runtime/index");

  controller = createDesktopAppController({
    startRuntime: () =>
      startEditorRuntime({
        staticDir: join(appPath, ".build", "dist"),
        crosspostDir: app.isPackaged ? join(process.resourcesPath, "Crosspost") : join(appPath, "../Crosspost"),
        userDataPath,
        libraryModulePath: app.isPackaged ? join(process.resourcesPath, "mpvfx_library.node") : join(appPath, ".build/native/library/mpvfx_library.node"),
        projectsDir: paths.projects,
        studioDir: appPath,
        editorContents: () => mainWindow?.webContents,
      }),
    prepareRenderer: () => prepareEditorRendererSession(session.defaultSession),
    createWindow: createEditorWindow,
    closeSharedBrowser,
    flushRenderer: () => flushRendererSaves(mainWindow),
  });
  await controller.start();
  console.log(`[MpVFX] Editor ready at ${controller.origin()}`);
}

function showFatalStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("MpVFX could not start", message);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      void controller?.activate();
    }
  });

  app.on("activate", () => {
    void controller?.activate().catch(showFatalStartupError);
  });

  app.on("window-all-closed", () => {
    if (shouldQuitWhenAllWindowsClosed(process.platform)) app.quit();
  });

  app.on("before-quit", (event) => {
    if (quittingAfterCleanup) return;
    event.preventDefault();
    if (quitInProgress) return;
    quitInProgress = true;
    void (controller?.close() ?? Promise.resolve())
      .then(() => { quittingAfterCleanup = true; app.quit(); })
      .catch((error) => {
        quitInProgress = false;
        dialog.showErrorBox("MpVFX could not finish saving", error instanceof Error ? error.message : String(error));
      });
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => app.quit());
  }

  void app
    .whenReady()
    .then(startDesktopApplication)
    .catch(async (error) => {
      showFatalStartupError(error);
      await controller?.close().catch(() => {});
      app.exit(1);
    });
}
