import { app, crashReporter, dialog, type BrowserWindow } from "electron";
import { cpus, freemem, totalmem, release } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createDiagnostics } from "../diagnostics/logger";
import { installDiagnosticSink, recordDiagnostic } from "../diagnostics/context";
import { installProcessDiagnostics } from "../diagnostics/processes";

function buildFingerprint(): string {
  try {
    // index.html names Vite's content-hashed renderer/CSS assets. Include it so
    // a renderer-only local change cannot be mistaken for the same build.
    const hash = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url)));
    hash.update(readFileSync(join(app.getAppPath(), "dist/index.html")));
    const lock = join(app.getAppPath(), "package-lock.json");
    if (existsSync(lock)) hash.update(readFileSync(lock));
    return hash.digest("hex");
  } catch { return "unavailable"; }
}

/** Cross-platform Crashpad and local JSONL timeline, installed before app.whenReady(). */
export function startDesktopDiagnostics(userDataDir: string) {
  const directory = join(userDataDir, "diagnostics");
  const nativeDirectory = join(directory, "native-crashes");
  const log = createDiagnostics({ directory, metadata: {
    appVersion: app.getVersion(), buildFingerprint: buildFingerprint(), packaged: app.isPackaged,
    platform: process.platform, architecture: process.arch, osRelease: release(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 },
    cpuModel: cpus()[0]?.model, logicalCores: cpus().length, totalMemoryBytes: totalmem(),
  } });
  installDiagnosticSink(log);
  installProcessDiagnostics();
  // Preserve normal console output. Disk recording is bounded and sanitized by
  // the sink; logger failures never recursively log to the console.
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      recordDiagnostic(`main.console.${level}`, { messages: args }, level === "error" ? "error" : level === "warn" ? "warn" : "info");
      Reflect.apply(original, console, args);
    };
  }
  process.on("uncaughtExceptionMonitor", (error, origin) => { recordDiagnostic("main.uncaught_exception", { error, origin }, "fatal"); });
  // Do not install unhandledRejection/uncaughtException handlers that change
  // Node's termination behavior. uncaughtExceptionMonitor captures fatal ones.
  process.on("warning", (warning) => recordDiagnostic("main.warning", { error: warning }, "warn"));

  function nativeDumpInventory() {
    const dumps: Array<{ absolute: string; size: number; modified: number }> = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3 || !existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const absolute = join(dir, name), stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) walk(absolute, depth + 1);
        else if (name.endsWith(".dmp")) dumps.push({ absolute, size: stat.size, modified: stat.mtimeMs });
      }
    };
    try {
      walk(nativeDirectory, 0);
      dumps.sort((a, b) => b.modified - a.modified);
      let bytes = 0, retained = 0, removed = 0;
      for (const dump of dumps) {
        // Never remove a dump still being written by Crashpad.
        const recent = Date.now() - dump.modified < 60_000;
        if (!recent && (Date.now() - dump.modified > 7 * 86_400_000 || bytes + dump.size > 100 * 1024 * 1024)) { unlinkSync(dump.absolute); removed++; }
        else { retained++; bytes += dump.size; }
      }
      recordDiagnostic("crash.dump_inventory", { count: retained, bytes, removed, includedInReports: false });
    } catch (error) { recordDiagnostic("crash.inventory_failed", { error }, "warn"); }
  }
  try {
    mkdirSync(nativeDirectory, { recursive: true, mode: 0o700 });
    app.setPath("crashDumps", nativeDirectory);
    crashReporter.start({ productName: "MpVFX", uploadToServer: false, globalExtra: { sessionId: log.sessionId } });
    recordDiagnostic("crash.recorder_ready", { uploadToServer: crashReporter.getUploadToServer() });
    nativeDumpInventory();
  } catch (error) { recordDiagnostic("crash.recorder_failed", { error }, "error"); }

  async function saveReport() {
    try {
      const report = await log.exportBundle();
      const result = await dialog.showSaveDialog({ title: "Save MpVFX diagnostic report", defaultPath: `MpVFX-diagnostics-${log.sessionId}.json.gz`, filters: [{ name: "Compressed diagnostic report", extensions: ["gz"] }] });
      if (!result.canceled && result.filePath) writeFileSync(result.filePath, report, { mode: 0o600 });
    } catch { dialog.showErrorBox("Diagnostic report unavailable", "Check disk space and permissions, then try again."); }
  }
  app.on("child-process-gone", (_event, details) => recordDiagnostic("electron.child_process_gone", { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name }, "error"));
  app.on("render-process-gone", (_event, contents, details) => {
    recordDiagnostic("electron.render_process_gone", { webContentsId: contents.id, ...details }, details.reason === "clean-exit" ? "info" : "fatal");
    setTimeout(nativeDumpInventory, 2000).unref();
  });
  const captureGpu = async (detail: "basic" | "complete" = "complete") => {
    try {
      const gpu = { detail, featureStatus: app.getGPUFeatureStatus(), info: await app.getGPUInfo(detail) };
      log.updateMetadata({ gpu });
      recordDiagnostic("system.gpu", gpu);
    }
    catch (error) { recordDiagnostic("system.gpu_unavailable", { error }, "warn"); }
  };
  // getGPUInfo("complete") can itself emit gpu-info-update. Listening to that
  // event for another capture creates an endless query/log loop. Collect two
  // startup snapshots explicitly, including on drivers that emit no update.
  void app.whenReady().then(async () => {
    await captureGpu("basic");
    await captureGpu("complete");
  });
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const sample = setInterval(() => {
    try {
    let freeDiskBytes: number | null = null;
    try { const disk = statfsSync(userDataDir); freeDiskBytes = disk.bavail * disk.bsize; } catch { /* unavailable filesystem metric */ }
    recordDiagnostic("system.sample", { memory: process.memoryUsage(), freeMemoryBytes: freemem(), freeDiskBytes, cpuTotalMicros: process.cpuUsage(), eventLoopMeanMs: Number.isFinite(loop.mean) ? Math.round(loop.mean / 1e6) : null, eventLoopMaxMs: Math.round(loop.max / 1e6), processes: app.isReady() ? app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type, cpu: metric.cpu, memory: metric.memory })) : [] });
    loop.reset();
    } catch (error) { recordDiagnostic("system.sample_failed", { error }, "warn"); }
  }, 10_000);
  sample.unref();
  const dumpTimer = setInterval(nativeDumpInventory, 60_000);
  dumpTimer.unref();

  function attachWindow(window: BrowserWindow) {
    const contents = window.webContents;
    const windowId = window.id;
    recordDiagnostic("window.created", { windowId, webContentsId: contents.id });
    window.on("unresponsive", () => recordDiagnostic("window.unresponsive", { windowId }, "error"));
    window.on("responsive", () => recordDiagnostic("window.responsive", { windowId }));
    window.on("closed", () => recordDiagnostic("window.closed", { windowId }));
    contents.on("did-finish-load", () => recordDiagnostic("window.loaded", { windowId }));
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => recordDiagnostic("window.load_failed", { windowId, code, description, isMainFrame }, "error"));
    contents.on("console-message", (details) => {
      if (details.level === "error" || details.level === "warning") recordDiagnostic("renderer.console", { windowId, message: details.message, line: details.lineNumber }, details.level === "error" ? "error" : "warn");
    });
    contents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") return;
      // Native UI remains usable even if the renderer and React error boundary died.
      // Attach the dialog to this window. An application-modal alert without a
      // parent can pause macOS's main loop, including report HTTP requests and
      // diagnostic heartbeats, for as long as the recovery prompt is open.
      void dialog.showMessageBox(window, { type: "error", title: "MpVFX editor stopped", message: "The editor process stopped unexpectedly.", detail: "The local diagnostic log has been preserved. Save a report to help investigate, then reopen the editor.", buttons: ["Save diagnostic report", "Reload editor", "Close"], defaultId: 0, cancelId: 2 }).then(async ({ response }) => {
        if (response === 0) await saveReport();
        if (response === 0 || response === 1) { if (!contents.isDestroyed()) contents.reload(); }
      });
    });
  }
  return { log, attachWindow, saveReport, close(clean = true) { clearInterval(sample); clearInterval(dumpTimer); loop.disable(); log.close(clean); } };
}
