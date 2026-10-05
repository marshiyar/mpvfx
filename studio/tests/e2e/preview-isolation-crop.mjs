// Packaged macOS app QA using only a disposable profile and project.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const app = resolve(process.env.MPVFX_PACKAGED_APP ?? "out/MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX");
const root = await mkdtemp(join(tmpdir(), "mpvfx-preview-crop-"));
const project = join(root, "data/projects/MpVFX");
await mkdir(join(project, ".studio"), { recursive: true });
// Transparent pixel; the image's CSS background makes its cropped edge easy to see.
await writeFile(join(project, "transparent.png"), Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64"));
const sourcePath = join(project, "index.html");
await writeFile(sourcePath, `<!doctype html><html><head><meta charset="utf-8"></head><body>
<main data-composition-id="main" data-width="640" data-height="360" data-duration="4"
  style="position:relative;width:640px;height:360px;background:white">
  <img id="crop-clip" class="clip" data-hf-id="hf-crop" data-studio-clip-id="clip:crop"
    data-start="0" data-duration="4" src="transparent.png"
    style="position:absolute;left:80px;top:80px;width:200px;height:100px;background:#e22626">
</main></body></html>`);
const nativePath = join(project, ".studio/project.json");
await writeFile(nativePath, JSON.stringify({
  schemaVersion: 1, id: "project:MpVFX", revision: 0,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 640, height: 360, background: "#ffffff" },
  assets: [{ id: "asset:crop", kind: "image", name: "Crop fixture", source: "transparent.png", durationFrames: 120 }],
  sequence: { id: "sequence:main", name: "Main", tracks: [{ id: "track:one", kind: "mixed", clips: [{
    id: "clip:crop", assetId: "asset:crop",
    binding: { sourceFile: "index.html", domId: "crop-clip", hfId: "hf-crop" },
    startFrame: 0, durationFrames: 120, sourceInFrame: 0,
    effects: [], parameterTracks: [],
  }] }] },
}, null, 2));

let log = "";
const child = spawn(app, ["--remote-debugging-port=0", `--user-data-dir=${join(root, "chromium")}`], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", MPVFX_USER_DATA_DIR: join(root, "data"),
    MPVFX_HIDDEN_TEST_WINDOW: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", chunk => { log += chunk; });
child.stderr.on("data", chunk => { log += chunk; });
let browser;
const waitFor = async (read, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    if (child.exitCode !== null) throw new Error(`App exited: ${log.slice(-3000)}`);
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timeout: ${log.slice(-3000)}`);
};
const savedCrop = async () => /clip-path\s*:\s*(inset\([^;"']+\))/i.exec(await readFile(sourcePath, "utf8"))?.[1] ?? null;
const clipState = frame => frame.evaluate(() => {
  const element = document.getElementById("crop-clip");
  const rect = element.getBoundingClientRect();
  return {
    clipPath: getComputedStyle(element).clipPath,
    hiddenEdgeHit: document.elementFromPoint(rect.left + 10, rect.top + rect.height / 2)?.id === "crop-clip",
    visibleCenterHit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.id === "crop-clip",
  };
});

try {
  const endpoint = await waitFor(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const page = await (await browser.waitForTarget(target => target.url().startsWith("mpvfx://editor/"),
    { timeout: 30000 })).page();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  const preview = await waitFor(() => page.frames().find(frame => frame.url().includes("/api/projects/MpVFX/preview")));
  const clip = await waitFor(async () => {
    const element = await preview.$("#crop-clip");
    return element && await element.boundingBox() ? element : null;
  });
  const before = await clipState(preview);
  if (!before.hiddenEdgeHit || !before.visibleCenterHit) throw new Error("Fixture image was not visibly hittable before crop");
  await page.screenshot({ path: join(root, "crop-before.png") });
  const box = await clip.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector('[aria-label="Crop selected layer"]', { timeout: 10000 });
  await page.click('[aria-label="Crop selected layer"]');
  const handle = await page.waitForSelector('[aria-label="Crop left edge"]', { timeout: 10000 });
  const handleBox = await handle.boundingBox();
  const x = handleBox.x + handleBox.width / 2;
  const y = handleBox.y + handleBox.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 25, y, { steps: 6 });
  await page.mouse.up();
  const authoredCrop = await waitFor(savedCrop, 10000);
  const inset = Number(/^inset\([^)]*?([\d.]+)px\)$/.exec(authoredCrop)?.[1]);
  if (!(inset >= 18 && inset <= 32)) throw new Error(`Unexpected saved crop: ${authoredCrop}`);
  const cropped = await waitFor(async () => {
    const state = await clipState(preview);
    return !state.hiddenEdgeHit && state.visibleCenterHit ? state : null;
  }, 10000);
  await page.screenshot({ path: join(root, "crop-applied.png") });

  await page.keyboard.down("Meta");
  await page.keyboard.press("z");
  await page.keyboard.up("Meta");
  await waitFor(async () => (await savedCrop()) === null, 10000);
  const undone = await waitFor(async () => {
    const frame = page.frames().find(candidate => candidate.url().includes("/api/projects/MpVFX/preview"));
    if (!frame) return null;
    const state = await clipState(frame);
    return state.hiddenEdgeHit ? state : null;
  }, 10000);
  await page.screenshot({ path: join(root, "crop-undone.png") });

  await page.keyboard.down("Meta");
  await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
  await waitFor(savedCrop, 10000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  const reopened = await waitFor(async () => {
    const frame = page.frames().find(candidate => candidate.url().includes("/api/projects/MpVFX/preview"));
    if (!frame) return null;
    const element = await frame.$("#crop-clip");
    return element && await element.boundingBox() ? frame : null;
  }, 10000);
  const afterReopen = await waitFor(async () => {
    const state = await clipState(reopened);
    return !state.hiddenEdgeHit && state.visibleCenterHit ? state : null;
  }, 10000);
  await page.screenshot({ path: join(root, "crop-reopened.png") });
  const evidence = { root, authoredCrop, before, cropped, undone, afterReopen,
    nativeRevision: JSON.parse(await readFile(nativePath, "utf8")).revision };
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  browser?.disconnect();
  child.kill("SIGTERM");
  await writeFile(join(root, "app.log"), log);
}
