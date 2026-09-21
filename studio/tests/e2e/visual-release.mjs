/** Visual acceptance of the published binaries, using only generated media. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, release as osRelease } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";

// Full-desktop evidence is safe only on a fresh hosted test machine. No local
// desktop, user projects, command output, report archive, or dump is uploaded.
assert.equal(process.env.GITHUB_ACTIONS, "true", "Use the disposable visual-verification workflow");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
const require = createRequire(import.meta.url);
const studio = resolve(import.meta.dirname, "../..");
const output = join(studio, "out/visual-release");
const evidence = join(output, "evidence");
const runtime = mkdtempSync(join(tmpdir(), "mpvfx-visual-"));
const profile = join(runtime, "profile");
const control = join(runtime, "control");
const downloads = join(runtime, "downloads");
for (const dir of [evidence, profile, control, downloads]) mkdirSync(dir, { recursive: true });
const version = "0.0.2";
const platform = process.platform;
const base = `https://github.com/marshiyar/mpvfx/releases/download/v${version}`;
const asset = platform === "win32" ? `MpVFX-${version}-Setup.exe` : platform === "darwin" ? `MpVFX-${version}-${process.arch}.dmg` : `mpvfx_${version}_amd64.deb`;
const ffmpeg = join(dirname(require.resolve("ffmpeg-static/package.json")), platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "ELECTRON_RUN_AS_NODE"));
environment.MPVFX_USER_DATA_DIR = profile;
const result = { version, platform, architecture: process.arch, osRelease: osRelease(), asset, passed: [], failures: [], exports: [], screenshots: [], limitations: ["Hosted virtual machine; physical GPU, Windows 11 SmartScreen, and user display scaling are not reproduced.", "File selection is supplied by the test driver; the OS file-picker interaction is not validated."] };
let app, browser, page, watcher, executable, mounted, phase = "download";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mark(value) { phase = value; writeFileSync(join(control, "phase"), value); console.log(`VISUAL_PHASE ${value}`); }
async function until(fn, description, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(150); }
  throw new Error(`Timed out: ${description}`);
}
async function download(name) {
  const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(180_000) });
  assert.equal(response.status, 200, `Download ${name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const target = join(downloads, name); writeFileSync(target, bytes); return { target, bytes };
}
function run(file, args, options = {}) { return execFileSync(file, args, { windowsHide: true, stdio: "pipe", timeout: 180_000, ...options }); }
async function screenshot(name) {
  if (page && !page.isClosed()) {
    const filename = `${name}-app.png`;
    await page.screenshot({ path: join(evidence, filename) });
    result.screenshots.push(filename);
  }
  if (platform === "darwin") { run("screencapture", ["-x", join(evidence, `${name}-desktop.png`)]); result.screenshots.push(`${name}-desktop.png`); }
  if (platform === "linux") { run("scrot", [join(evidence, `${name}-desktop.png`)]); result.screenshots.push(`${name}-desktop.png`); }
  // Windows is recorded continuously, including native dialogs and transients.
  await sleep(1200);
}
async function report() {
  const response = await fetch(`${new URL(page.url()).origin}/api/diagnostics/export`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  return JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString());
}
async function launch() {
  let messages = "";
  app = spawn(executable, ["--remote-debugging-port=0", ...(platform === "linux" ? ["--no-sandbox"] : [])], { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [app.stdout, app.stderr]) stream.on("data", (chunk) => { messages = (messages + String(chunk)).slice(-64000); });
  app.on("error", () => {});
  const endpoint = await until(() => {
    if (app.exitCode !== null) throw new Error(`Released app exited at startup (${app.exitCode})`);
    return messages.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
  }, "released app debugging endpoint");
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null, protocolTimeout: 30_000 });
  page = await until(async () => (await browser.pages()).find((p) => /^http:\/\/127\.0\.0\.1:\d+/.test(p.url())), "editor page");
  await page.waitForSelector('[data-diagnostic-action="diagnostics-toggle"]');
  const client = await page.createCDPSession();
  // Test the real OS window at the normal size, then the supported minimum.
  const { windowId } = await client.send("Browser.getWindowForTarget");
  await client.send("Browser.setWindowBounds", { windowId, bounds: { left: 20, top: 30, width: 1440, height: 900, windowState: "normal" } });
  await page.bringToFront();
  return client;
}
async function stopApp() {
  browser?.disconnect(); browser = null;
  if (app && app.exitCode === null && app.signalCode === null) {
    if (platform === "win32") { try { run("taskkill.exe", ["/pid", String(app.pid), "/T", "/F"]); } catch {} }
    else app.kill("SIGKILL");
    await until(() => app.exitCode !== null || app.signalCode !== null, "own test process stopped", 10_000).catch(() => {});
  }
  app = null; page = null;
}
const select = (selector) => `pierce/${selector}`;
async function click(selector) { const element = await page.waitForSelector(select(selector), { visible: true }); await element.click(); }
async function buttonText(text) {
  const buttons = await page.$$(select('button, [role="menuitem"]'));
  for (const button of buttons) if ((await button.evaluate((el) => el.textContent.trim())) === text) { await button.click(); return; }
  throw new Error(`Visible button missing: ${text}`);
}
async function choose(option) {
  for (const field of await page.$$(select("select"))) {
    if (await field.evaluate((el, value) => [...el.options].some((item) => item.value === value), option)) { await field.select(option); return; }
  }
  throw new Error(`Select option missing: ${option}`);
}
async function setNumber(label, value) {
  const field = await page.$(select(`[aria-label="${label}"]`));
  assert.ok(field, `Input ${label}`);
  await field.click({ clickCount: 3 }); await field.press("Backspace"); await field.type(String(value)); await field.press("Tab");
}
async function render(format, ordinal, cancel = false) {
  mark(`${format}-${cancel ? "cancel" : "render"}-${ordinal}`);
  await choose(format);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/projects/MpVFX/render") && response.request().method() === "POST", { timeout: 20_000 });
  const started = Date.now();
  await click('[data-diagnostic-action="export-video"]');
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  const { jobId } = await response.json();
  assert.ok(jobId);
  if (cancel) {
    await page.waitForSelector(select('[role="progressbar"]'));
    await screenshot("06-cancelling");
    await buttonText("Cancel");
  } else await screenshot(`0${ordinal + 3}-${format}-rendering`);
  let last;
  await until(async () => {
    last = (await report()).events.findLast((e) => e.event === "export.finished" && e.context.jobId === jobId);
    return last;
  }, `${format} ${cancel ? "cancel" : "export"} finished`, 240_000);
  assert.equal(last.data.status, cancel ? "cancelled" : "complete", `Export ${ordinal}: ${JSON.stringify(last.data)}`);
  const timing = { format, status: last.data.status, elapsedMs: Date.now() - started };
  if (!cancel) {
    const rendered = join(profile, "renders", `${jobId}.${format}`);
    assert.ok(existsSync(rendered), "Completed output must exist");
    // Check the rendered cuts contain actual source pixels, not just progress.
    const pixel = (time) => [...run(ffmpeg, ["-v", "error", "-ss", String(time), "-i", rendered, "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"])];
    const red = pixel(0.5), blue = pixel(2.5);
    assert.ok(red[0] > 150 && red[2] < 80 && blue[2] > 150 && blue[0] < 80, "Export must preserve red and blue source frames after the UI cuts");
    run(ffmpeg, ["-v", "error", "-y", "-ss", "0.5", "-i", rendered, "-frames:v", "1", join(evidence, `output-${ordinal}-red.png`)]);
    run(ffmpeg, ["-v", "error", "-y", "-ss", "2.5", "-i", rendered, "-frames:v", "1", join(evidence, `output-${ordinal}-blue.png`)]);
    // Only generated render content is copied into the visual evidence.
    if (format === "mp4" && ordinal === 1) writeFileSync(join(evidence, "edited-output.mp4"), readFileSync(rendered));
    const helpers = (await report()).events.filter((e) => e.event === "process.start" && e.context.jobId === jobId);
    assert.ok(helpers.some((e) => /chrome|headless/i.test(e.data.executable)));
    assert.ok(helpers.some((e) => /ffmpeg/i.test(e.data.executable)));
    timing.helperCount = helpers.length;
  }
  result.exports.push(timing);
  await until(async () => !(await page.$eval(select('[data-diagnostic-action="export-video"]'), (el) => el.disabled)), "export button ready again");
  await screenshot(`0${ordinal + 3}-${format}-${cancel ? "cancelled" : "complete"}`);
}
try {
  const manifest = (await download("SHA256SUMS")).bytes.toString();
  const { target: installer, bytes } = await download(asset);
  result.sha256 = createHash("sha256").update(bytes).digest("hex");
  const checksums = manifest.trim().split(/\r?\n/).map((line) => line.match(/^([a-f0-9]{64})\s+\*?(?:\.\/)?(.+)$/));
  assert.ok(checksums.every(Boolean), "SHA256SUMS entries must be valid");
  const expected = checksums.find((entry) => entry[2] === asset)?.[1];
  assert.ok(expected, "Published checksum must name the exact installer");
  assert.equal(result.sha256, expected, "Published asset checksum");
  result.passed.push("published-installer-checksum");
  if (platform === "win32") {
    watcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", join(import.meta.dirname, "windows-desktop-watch.ps1"), "-EvidenceDirectory", evidence, "-ControlDirectory", control], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let watcherError = "";
    watcher.stderr.on("data", (chunk) => { watcherError = (watcherError + String(chunk)).slice(-4000); });
    await until(() => {
      if (watcher.exitCode !== null) throw new Error(`Desktop monitor exited ${watcher.exitCode}: ${watcherError}`);
      return existsSync(join(control, "monitor-ready"));
    }, "desktop monitor started");
    mark("installer");
    const setup = spawn(installer, [], { env: environment, windowsHide: true, stdio: "ignore" });
    executable = join(process.env.LOCALAPPDATA, "MpVFX", `app-${version}`, "MpVFX.exe");
    await until(() => existsSync(executable), "Squirrel installed application", 120_000);
    await until(() => setup.exitCode !== null, "installer exited", 120_000);
    result.installerExitCode = setup.exitCode;
    assert.equal(setup.exitCode, 0);
    await sleep(5000);
    // Only a fresh hosted runner is permitted; this process name belongs to
    // the installer we just started, never to a developer's running editor.
    try { run("taskkill.exe", ["/IM", "MpVFX.exe", "/T", "/F"]); } catch {}
    const shortcutRoots = [join(process.env.APPDATA, "Microsoft/Windows/Start Menu/Programs"), join(process.env.USERPROFILE, "Desktop")];
    result.shortcuts = shortcutRoots.flatMap((root) => existsSync(root) ? readdirSync(root, { recursive: true }).map(String).filter((name) => /mpvfx.*\.lnk$/i.test(name)) : []);
    result.passed.push("visible-squirrel-installation");
  } else if (platform === "darwin") {
    mark("mount-dmg");
    mounted = join(runtime, "mounted"); mkdirSync(mounted);
    run("hdiutil", ["attach", installer, "-nobrowse", "-mountpoint", mounted]);
    const application = join(runtime, "MpVFX.app"); run("ditto", [join(mounted, "MpVFX.app"), application]);
    executable = join(application, "Contents/MacOS/MpVFX");
    result.passed.push("published-dmg-mounted-and-app-copied");
  } else {
    mark("install-deb");
    run("sudo", ["apt-get", "install", "--yes", installer]);
    executable = "/usr/lib/mpvfx/MpVFX";
    assert.ok(existsSync(executable));
    result.passed.push("published-deb-installed");
  }
  // A synthetic four-second clip; no repository fixture or user's media.
  const source = join(runtime, "visual-source.mp4");
  run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=2", "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
  mark("first-launch");
  let client = await launch();
  const startup = (await report()).events.findLast((e) => e.event === "session.start");
  assert.equal(startup.data.appVersion, version); assert.equal(startup.data.packaged, true);
  result.buildFingerprint = startup.data.buildFingerprint;
  await screenshot("01-first-launch");
  result.passed.push("released-app-first-launch");
  mark("import-media");
  const picker = page.waitForFileChooser();
  await click('[data-diagnostic-action="import-media"]');
  await (await picker).accept([source]);
  const card = await page.waitForSelector(select('[role="button"][aria-label^="visual-source —"]'), { timeout: 45_000 });
  await card.click({ button: "right" });
  await buttonText("Add at playhead");
  await page.waitForSelector(select('[data-clip="true"]'), { timeout: 45_000 });
  await screenshot("02-imported-media");
  result.passed.push("ui-media-import-and-add-to-timeline");
  mark("timeline-cuts");
  // The clip's measured width maps its declared interval to a ruler position.
  // Use the production selection/ruler/split controls, never dev-only stores.
  for (const time of [1, 2, 3]) {
    const clips = await page.$$(select('[data-clip="true"]'));
    let selected;
    for (const candidate of clips) {
      const interval = await candidate.evaluate((el) => [Number(el.dataset.clipStart), Number(el.dataset.clipEnd)]);
      if (interval[0] < time && interval[1] > time) { selected = { candidate, interval }; break; }
    }
    assert.ok(selected, `Clip spans cut ${time}`);
    const clipBounds = await selected.candidate.boundingBox();
    const viewport = await page.$(select('[data-timeline-scroll-viewport]'));
    const viewportBounds = await viewport.boundingBox();
    await selected.candidate.click();
    const x = clipBounds.x + clipBounds.width * (time - selected.interval[0]) / (selected.interval[1] - selected.interval[0]);
    await page.mouse.click(x, viewportBounds.y + 10);
    await click('[data-diagnostic-action="split-clip"]');
    await until(async () => (await page.$$(select('[data-clip="true"]'))).length > clips.length, `UI split at ${time}s`);
  }
  await screenshot("03-three-cuts");
  result.passed.push("three-ui-timeline-cuts");
  const tabs = await page.$$(select("button"));
  let renderTab;
  for (const tab of tabs) if (/^Renders(?:\s*\(\d+\))?$/.test(await tab.evaluate((el) => el.textContent.trim()))) { renderTab = tab; break; }
  assert.ok(renderTab); await renderTab.click();
  await page.waitForSelector(select('[data-diagnostic-action="export-video"]'));
  await choose("custom"); await setNumber("Custom export width", 640); await setNumber("Custom export height", 360);
  await render("mp4", 1);
  await render("mov", 2);
  await render("mp4", 3, true);
  await render("mp4", 4);
  result.passed.push("ui-mp4-and-mov-export-with-verified-pixels", "ui-cancel-and-repeat-export");
  mark("minimum-window");
  const { windowId } = await client.send("Browser.getWindowForTarget");
  await client.send("Browser.setWindowBounds", { windowId, bounds: { width: 1024, height: 640 } });
  await screenshot("08-minimum-window");
  await client.send("Browser.setWindowBounds", { windowId, bounds: { width: 1440, height: 900 } });
  mark("diagnostic-report");
  await click('[data-diagnostic-action="diagnostics-toggle"]');
  await screenshot("09-diagnostics");
  await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await click('[data-diagnostic-action="diagnostics-export"]');
  const saved = await until(() => readdirSync(downloads).find((name) => /^MpVFX-diagnostics-.*\.json\.gz$/.test(name)), "diagnostic report saved");
  const savedReport = JSON.parse(gunzipSync(readFileSync(join(downloads, saved))).toString());
  assert.ok(savedReport.events.some((e) => e.event === "client.ui.click" && e.data.detail?.target?.action === "diagnostics-export"));
  result.passed.push("ui-save-diagnostic-report");
  mark("native-renderer-crash");
  void client.send("Page.crash").catch(() => {});
  const crashed = await until(async () => {
    const value = await report();
    return value.events.some((e) => e.event === "electron.render_process_gone") ? value : null;
  }, "native crash captured");
  await sleep(2500);
  // The renderer has gone; use native desktop evidence, not a CDP screenshot.
  const crashedPage = page; page = null; await screenshot("10-native-crash-dialog"); page = crashedPage;
  await stopApp();
  mark("restart-after-crash"); client = await launch();
  const recovered = await report();
  assert.ok(recovered.events.some((e) => e.event === "session.previous_unclean_exit" && e.data.previousSessionId === crashed.sessionId));
  assert.equal((await page.$$(select('[data-clip="true"]'))).length, 4);
  await screenshot("11-recovered-editor");
  result.passed.push("native-crash-dialog-and-restart-with-cuts-preserved");
  mark("complete");
} catch (error) {
  result.failures.push({ phase, message: error.message });
  try { await screenshot("failure"); } catch {}
  process.exitCode = 1;
} finally {
  await stopApp();
  if (watcher) {
    writeFileSync(join(control, "monitor-stop"), "stop");
    await until(() => watcher.exitCode !== null, "desktop recorder stopped", 10_000).catch(() => watcher.kill());
    const capturePath = join(evidence, "windows-desktop.json");
    if (existsSync(capturePath)) {
      const capture = JSON.parse(readFileSync(capturePath, "utf8").replace(/^\uFEFF/, ""));
      const baseline = new Set((capture.observations.find((item) => item.phase === "baseline")?.windows ?? []).map((window) => window.handle));
      const consoleClass = /ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS|VirtualConsoleClass/i;
      const unexpected = capture.observations.flatMap((observation) => (observation.windows ?? []).filter((window) => consoleClass.test(window.className) && !baseline.has(window.handle)).map((window) => ({ elapsedMs: observation.elapsedMs, phase: observation.phase, ...window })));
      result.windowsDesktop = { frames: capture.frames, durationMs: capture.durationMs, eventHookActive: capture.eventHookActive, sampleIntervalMs: capture.sampleIntervalMs, screenWidth: capture.screenWidth, screenHeight: capture.screenHeight, unexpectedConsoleObservations: unexpected.length };
      if (unexpected.length) { result.failures.push({ phase: "desktop-monitor", message: "Unexpected native console windows were observed", observations: unexpected }); process.exitCode = 1; }
      if (!capture.eventHookActive || capture.frames < 3) { result.failures.push({ phase: "desktop-monitor", message: "Insufficient native desktop evidence" }); process.exitCode = 1; }
      try { run(ffmpeg, ["-v", "error", "-y", "-framerate", "1", "-i", join(evidence, "desktop-%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", join(evidence, "windows-desktop.mp4")]); } catch { result.limitations.push("Desktop movie encoding failed; individual desktop frames remain available."); }
    } else { result.failures.push({ phase: "desktop-monitor", message: "Native desktop capture was unavailable" }); process.exitCode = 1; }
  }
  if (mounted) { try { run("hdiutil", ["detach", mounted]); } catch {} }
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  rmSync(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
