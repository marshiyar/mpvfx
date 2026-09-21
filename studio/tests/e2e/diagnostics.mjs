/** Native Electron smoke: isolated data only; never attaches to an existing editor. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import { verifyIdleRendererMemory } from "./idle-renderer-memory.mjs";

const require = createRequire(import.meta.url);
const studio = resolve(import.meta.dirname, "../..");
const output = join(studio, "out/diagnostics-verification");
mkdirSync(output, { recursive: true });
const oldDownloads = new Set(readdirSync(output));
const runtime = mkdtempSync(join(tmpdir(), "mpvfx-native-diagnostics-"));
const project = join(runtime, "projects/MpVFX");
const packaged = process.argv.includes("--packaged");
const packageDirectory = join(studio, "out", `MpVFX-${process.platform}-${process.arch}`);
const electron = packaged ? join(packageDirectory, process.platform === "darwin" ? "MpVFX.app/Contents/MacOS/MpVFX" : process.platform === "win32" ? "MpVFX.exe" : "MpVFX") : require("electron");
let child, browser;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await sleep(100); }
  throw new Error("Diagnostic smoke condition timed out");
}
async function launch() {
  let stderr = "";
  // On Windows even an empty ELECTRON_RUN_AS_NODE enables Node-only mode.
  // Remove the key, including any case variant, from the child environment.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "ELECTRON_RUN_AS_NODE"));
  environment.MPVFX_USER_DATA_DIR = runtime;
  child = spawn(electron, ["--remote-debugging-port=0", ...(process.platform === "linux" ? ["--no-sandbox"] : []), ...(packaged ? [] : [studio])], { cwd: studio, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-64_000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-64_000); });
  const endpoint = await until(() => {
    if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}: ${stderr.slice(-2000)}`);
    return stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
  });
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null, protocolTimeout: 30_000 });
  const page = await until(async () => (await browser.pages()).find((p) => /^http:\/\/127\.0\.0\.1:\d+/.test(p.url())));
  await page.waitForSelector('[data-diagnostic-action="diagnostics-toggle"]', { timeout: 30_000 });
  return page;
}
async function stopAbruptly() {
  browser?.disconnect(); browser = null;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await until(() => child.exitCode !== null || child.signalCode !== null);
  }
}
async function getReport(origin) {
  const response = await fetch(`${origin}/api/diagnostics/export`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  return JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString());
}
try {
  mkdirSync(join(project, "vendor"), { recursive: true });
  copyFileSync(require.resolve("gsap/dist/gsap.min.js"), join(project, "vendor/gsap.min.js"));
  const ffmpeg = join(dirname(require.resolve("ffmpeg-static/package.json")), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=30:d=1", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=30:d=1", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(project, "source.mp4")], { windowsHide: true, stdio: "pipe" });
  writeFileSync(join(project, "index.html"), `<!doctype html><html><head><style>html,body{margin:0}video{position:absolute;left:0;top:0;width:160px;height:90px;object-fit:contain}</style><script src="vendor/gsap.min.js"></script></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="160" data-height="90" style="position:relative;width:160px;height:90px;background:black">
<video id="cut-a" class="clip" src="source.mp4" data-start="0" data-duration="0.5" data-media-start="0.25" data-track-index="0" data-has-audio="true" playsinline></video>
<video id="cut-b" class="clip" src="source.mp4" data-start="0.5" data-duration="0.5" data-media-start="1.25" data-track-index="0" data-has-audio="true" playsinline></video>
</div><script>window.__timelines = { main: gsap.timeline({ paused: true }) };</script></body></html>`);
  const page = await launch();
  const origin = new URL(page.url()).origin;
  await verifyIdleRendererMemory(page, join(output, `idle-memory-${process.platform}.json`));
  const start = await fetch(`${origin}/api/projects/MpVFX/render`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "mov", fps: 30, quality: "draft", telemetryOptOut: true }) });
  assert.equal(start.status, 200);
  const { jobId } = await start.json();
  assert.ok(jobId);
  const renderHeartbeat = setInterval(() => { void fetch(`${origin}/api/render/${jobId}/heartbeat`, { method: "POST" }).catch(() => {}); }, 10_000);
  try {
    const progress = await fetch(`${origin}/api/render/${jobId}/progress`, { signal: AbortSignal.timeout(120_000) });
    const states = [...(await progress.text()).matchAll(/^data:(.*)$/gm)].map((match) => JSON.parse(match[1].trim()));
    assert.equal(states.at(-1)?.status, "complete", JSON.stringify(states.at(-1)));
    const report = await getReport(origin);
    writeFileSync(join(output, `render-report-${process.platform}.json`), JSON.stringify(report, null, 2));
    assert.ok(report.events.some((e) => e.event === "export.finished" && e.context.jobId === jobId && e.data.status === "complete"));
    const helpers = report.events.filter((e) => e.event === "process.start" && e.context.jobId === jobId);
    assert.ok(helpers.some((e) => /chrome|headless/i.test(e.data.executable)), "Chromium launch lost its export context");
    assert.ok(helpers.some((e) => /ffmpeg/i.test(e.data.executable)), "FFmpeg launch lost its export context");
    assert.ok(helpers.every((e) => e.data.windowsHide === true), JSON.stringify(helpers.filter((e) => e.data.windowsHide !== true).map((e) => e.data)));
    if (process.platform === "win32") assert.ok(helpers.filter((e) => /chrome|headless/i.test(e.data.executable)).every((e) => e.data.detached === false));
    const rendered = join(runtime, "renders", `${jobId}.mov`);
    const pixel = (at) => [...execFileSync(ffmpeg, ["-v", "error", "-ss", String(at), "-i", rendered, "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { windowsHide: true })];
    const red = pixel(0.25), blue = pixel(0.75);
    assert.ok(red[0] > 180 && red[2] < 60 && blue[2] > 180 && blue[0] < 60, "Logging changed the two-cut rendered output");
    console.log("DIAGNOSTICS_CHECK export pixels and correlated helpers passed");
  } finally { clearInterval(renderHeartbeat); }
  await page.click('[data-diagnostic-action="diagnostics-toggle"]');
  await page.waitForSelector('[data-diagnostic-action="diagnostics-export"]');
  const session = await page.createCDPSession();
  await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: output });
  writeFileSync(join(runtime, "projects/MpVFX/diagnostic-error.js"), 'setTimeout(() => { throw new Error("diagnostics-smoke-renderer-error token=CANARY_SECRET"); }, 0);');
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "password"; input.value = "CANARY_TYPED_CREDENTIAL";
    document.body.append(input);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.remove();
  });
  // A same-origin module gives ErrorEvent a real stack; CDP-injected scripts
  // correctly produce only "Script error." under Chromium's origin policy.
  await page.evaluate(() => import("/api/projects/MpVFX/preview/diagnostic-error.js"));
  await until(async () => (await getReport(origin)).events.some((e) => e.event === "client.renderer.error" && JSON.stringify(e).includes("diagnostics-smoke-renderer-error")));
  await until(async () => {
    const events = (await getReport(origin)).events;
    return events.some((e) => e.event === "system.sample") && events.some((e) => e.event === "client.renderer.heartbeat");
  });
  await page.click('[data-diagnostic-action="diagnostics-export"]');
  const downloaded = await until(() => readdirSync(output).find((name) => !oldDownloads.has(name) && name.startsWith("MpVFX-diagnostics-") && name.endsWith(".json.gz")));
  const downloadedText = gunzipSync(readFileSync(join(output, downloaded))).toString();
  assert.ok(!downloadedText.includes("CANARY_"), "A private canary reached the exported report");
  const report = JSON.parse(downloadedText);
  assert.ok(report.events.some((e) => e.event === "client.ui.click" && e.data.detail.target.action === "diagnostics-export"));
  assert.ok(report.events.some((e) => e.event === "client.renderer.error" && JSON.stringify(e).includes("diagnostics-smoke-renderer-error")));
  assert.ok(report.events.some((e) => e.event === "system.gpu"));
  assert.ok(report.events.filter((e) => e.event === "system.gpu").length <= 2, "GPU diagnostics entered a collection feedback loop");
  const startup = report.events.find((e) => e.event === "session.start");
  assert.equal(startup.data.platform, process.platform);
  assert.equal(startup.data.architecture, process.arch);
  assert.equal(startup.data.packaged, packaged);
  assert.equal(startup.data.appVersion, JSON.parse(readFileSync(join(studio, "package.json"), "utf8")).version);
  assert.match(startup.data.buildFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(report.events.some((e) => e.event === "crash.recorder_ready" && e.data.uploadToServer === false));
  console.log("DIAGNOSTICS_CHECK downloaded report, redaction, and local crash recorder passed");
  await page.screenshot({ path: join(output, `diagnostics-${process.platform}.png`) });
  // An actual renderer process crash, not a simulated JavaScript Error.
  void session.send("Page.crash").catch(() => {});
  const crashed = await until(async () => {
    const next = await getReport(origin);
    return next.events.some((e) => e.event === "electron.render_process_gone" && e.data.reason !== "clean-exit") ? next : null;
  });
  assert.ok(crashed.events.some((e) => e.event === "client.ui.click"));
  console.log("DIAGNOSTICS_CHECK report remains accessible while the native crash recovery dialog is open");
  const previousSession = crashed.sessionId;
  await until(() => readdirSync(join(runtime, "diagnostics/native-crashes"), { recursive: true }).some((file) => String(file).endsWith(".dmp")));
  console.log("DIAGNOSTICS_CHECK native minidump recorded locally");
  await stopAbruptly();
  const restartedPage = await launch();
  const restarted = await getReport(new URL(restartedPage.url()).origin);
  assert.notEqual(restarted.sessionId, previousSession);
  assert.ok(restarted.events.some((e) => e.event === "session.previous_unclean_exit" && e.data.previousSessionId === previousSession));
  assert.ok(restarted.events.some((e) => e.event === "electron.render_process_gone"));
  const disk = readdirSync(join(runtime, "diagnostics")).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(runtime, "diagnostics", name), "utf8")).join("");
  assert.ok(!disk.includes("CANARY_"), "A private canary reached persistent logs");
  writeFileSync(join(output, `result-${process.platform}.json`), JSON.stringify({ platform: process.platform, architecture: process.arch, passed: ["native-startup", "idle-renderer-memory", "edited-video-export-pixels", "job-correlated-chromium-and-ffmpeg", "actual-click", "renderer-error", "downloaded-report", "redaction-on-disk", "gpu-metadata", "bounded-gpu-capture", "performance-heartbeats", "local-crash-reporter", "native-renderer-crash", "native-minidump-on-disk", "restart-recovery"], eventCount: restarted.events.length }, null, 2));
  console.log(`DIAGNOSTICS_VERIFIED ${process.platform}/${process.arch}: click → disk → downloaded report, native renderer crash and restart recovery`);
} finally {
  await stopAbruptly();
  rmSync(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
