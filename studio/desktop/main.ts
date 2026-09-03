import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, session } from "electron";
import { createDesktopAppController, shouldQuitWhenAllWindowsClosed } from "./appLifecycle";
import { resolveInstalledMediaBinaryPaths } from "./installedMediaBinaries";
import { ensureDesktopProject, resolveDesktopDataPaths } from "./projectPaths";
import { prepareEditorRendererSession } from "./rendererCache";
import { applyDesktopRuntimeEnvironment } from "./runtimeBinaries";
import { createWindowOptions, installWindowGuards } from "./windowPolicy";
import { assertBundledMediaBinariesAvailable } from "../vite.bundled-media-binaries";

app.setName("MpVFX");
app.setAppUserModelId("com.mpvfx.editor");

let mainWindow: BrowserWindow | null = null;
let quittingAfterCleanup = false;
let controller: ReturnType<typeof createDesktopAppController> | null = null;

function configurePermissions(): void {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

function createEditorWindow(): BrowserWindow {
  const editorWindow = new BrowserWindow(createWindowOptions());
  mainWindow = editorWindow;
  editorWindow.setMenu(null);
  editorWindow.once("ready-to-show", () => editorWindow.show());
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
    backgroundRemovalModelsDir: join(paths.cache, "background-removal-models"),
  });
  assertBundledMediaBinariesAvailable();

  // Load the server/render graph only after the packaged paths exist. Several
  // upstream packages cache FFmpeg-family discovery at module scope; a static
  // import here allowed that graph to observe a stale shell override before the
  // desktop runtime replaced it with this build's bundled executables.
  const { startStudioServer } = await import("./editorServer");
  const { closeSharedBrowser } = await import("../vite.browser");

  controller = createDesktopAppController({
    startServer: () =>
      startStudioServer({
        staticDir: join(appPath, "dist"),
        projectsDir: paths.projects,
        studioDir: appPath,
        version: app.getVersion(),
      }),
    prepareRenderer: () => prepareEditorRendererSession(session.defaultSession),
    createWindow: createEditorWindow,
    closeSharedBrowser,
  });
  await controller.start();
  console.log(`[MpVFX] Editor listening on ${controller.origin()}`);
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
    quittingAfterCleanup = true;
    void (controller?.close() ?? Promise.resolve())
      .catch((error) => console.error("[MpVFX] Shutdown cleanup failed:", error))
      .finally(() => app.quit());
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
