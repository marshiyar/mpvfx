// Exercise the packaged desktop export path on a disposable copy of a project.
// MPVFX_AUDIO_PROJECT selects a local fixture. Original files are never written.
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";
const require = createRequire(import.meta.url);
const source = process.env.MPVFX_AUDIO_PROJECT;
if (!source) throw new Error("Set MPVFX_AUDIO_PROJECT to the project fixture directory");
const root = await mkdtemp(join(tmpdir(), "mpvfx-audio-packaged-"));
const project = join(root, "data/projects/AudioRegression");
await mkdir(project, { recursive: true });
await cp(source, project, { recursive: true });
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const before = await hash(join(source, "index.html"));
const nativeBefore = await hash(join(source, ".studio/project.json"));
let log = "", browser;
const child = spawn(resolve("out/MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX"), [
  "--remote-debugging-port=0", `--user-data-dir=${join(root, "chromium")}`,
], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "", MPVFX_USER_DATA_DIR: join(root, "data") }, stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", b => { log += b; });
child.stdout.on("data", b => { log += b; });
const until = async (fn, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    if (child.exitCode !== null) throw new Error(`App exited: ${log.slice(-3000)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timeout: ${log.slice(-3000)}`);
};
try {
  const endpoint = await until(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const page = await (await browser.waitForTarget(t => t.url().startsWith("mpvfx://editor/"))).page();
  await page.waitForFunction(() => !!window.mpvfx);
  await page.setViewport({ width: 1500, height: 950 });
  await page.evaluate(() => { location.hash = "#project/AudioRegression"; });
  // Read original stream facts through the same Electron boundary as asset drops.
  const doc = JSON.parse(await readFile(join(project, ".studio/project.json"), "utf8"));
  const streamFacts = await page.evaluate(async assets => {
    const results = [];
    for (const asset of assets) {
      const response = await window.mpvfx.request({ id: crypto.randomUUID(), method: "GET", headers: [], path: `/api/projects/AudioRegression/media/streams?source=${encodeURIComponent(asset.source)}` });
      results.push({ name: asset.name, status: response.status, body: new TextDecoder().decode(response.body) });
    }
    return results;
  }, doc.assets);
  console.log("metadata", JSON.stringify(streamFacts));
  const response = await page.evaluate(async () => {
    const result = await window.mpvfx.request({ id: crypto.randomUUID(), path: "/api/projects/AudioRegression/render", method: "POST",
      headers: [["content-type", "application/json"]], body: new TextEncoder().encode(JSON.stringify({ format: "mp4", fps: 30, quality: "draft" })).buffer });
    const data = JSON.parse(new TextDecoder().decode(result.body));
    if (result.status !== 200) throw new Error(JSON.stringify(data));
    window.audioExportEvents = [];
    window.stopAudioExportEvents = window.mpvfx.subscribe(`/api/render/${data.jobId}/progress`, e => {
      window.audioExportEvents.push(e);
    });
    window.audioHeartbeat = setInterval(() => void window.mpvfx.request({ id: crypto.randomUUID(), method: "POST", headers: [], path: `/api/render/${data.jobId}/heartbeat` }), 2000);
    return data;
  });
  console.log("started", JSON.stringify(response));
  let last = "";
  const final = await until(async () => {
    const events = await page.evaluate(() => window.audioExportEvents);
    const raw = events.filter(e => e.type === "progress").at(-1);
    if (!raw) return null;
    const state = JSON.parse(raw.data);
    const status = `${state.stage} ${Math.floor(state.progress)}`;
    if (status !== last) { console.log(status); last = status; }
    return state.status !== "rendering" ? state : null;
  }, 240000);
  await page.screenshot({ path: join(root, "export.png") });
  const evidence = { root, response, final, streamFacts, sourceUnchanged: before === await hash(join(source, "index.html")) && nativeBefore === await hash(join(source, ".studio/project.json")) };
  if (process.env.MPVFX_EXPECT_AUDIO_FAILURE === "1") {
    if (!final.error?.includes("expected: audio")) throw new Error(`Expected original failure: ${JSON.stringify(final)}`);
  } else {
    if (final.status !== "complete") throw new Error(JSON.stringify(final));
    const files = await readdir(join(root, "data/renders"));
    const output = join(root, "data/renders", files.find(f => f.endsWith(".mp4")));
    const ffprobe = require("@ffprobe-installer/ffprobe").path;
    evidence.output = output;
    evidence.probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,nb_frames:format=duration", "-of", "json", output]));
  }
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await writeFile(join(root, "app.log"), log);
  browser?.disconnect();
  child.kill("SIGTERM");
}
