// Packaged animated crop QA. All files and app state live in a disposable profile.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const app = resolve(process.env.MPVFX_PACKAGED_APP ?? "out/MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX");
const root = await mkdtemp(join(tmpdir(), "mpvfx-preview-animated-crop-"));
const project = join(root, "data/projects/MpVFX");
await mkdir(join(project, ".studio"), { recursive: true });
await writeFile(join(project, "transparent.png"), Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64"));
await writeFile(join(project, "index.html"), `<!doctype html><html><body>
<main data-composition-id="main" data-width="640" data-height="360" data-duration="4"
  style="position:relative;width:640px;height:360px;background:white">
<img id="crop-clip" data-hf-id="hf-crop" data-studio-clip-id="clip:crop" data-start="0" data-duration="4"
 src="transparent.png" style="position:absolute;left:100px;top:110px;width:200px;height:100px;background:#e22626;clip-path:inset(10px 20px 30px 40px)">
</main></body></html>`);
const frameRate = { numerator: 30, denominator: 1 };
const track = (parameterId, values) => ({ schemaVersion: 1, id: `track:${parameterId}`, parameterId,
  valueType: "number", frameRate, keyframes: values.map((value, index) => ({
    id: `key:${parameterId}:${index}`, frame: index * 45, value,
    outgoing: { type: "linear" },
  })) });
const nativePath = join(project, ".studio/project.json");
await writeFile(nativePath, JSON.stringify({
  schemaVersion: 1, id: "project:MpVFX", revision: 0, frameRate,
  canvas: { width: 640, height: 360, background: "#fff" },
  assets: [{ id: "asset:crop", kind: "image", name: "Crop", source: "transparent.png", durationFrames: 300 }],
  sequence: { id: "sequence:main", name: "Main", tracks: [{ id: "track:one", kind: "mixed", clips: [{
    id: "clip:crop", assetId: "asset:crop", binding: { sourceFile: "index.html", domId: "crop-clip", hfId: "hf-crop" },
    startFrame: 0, durationFrames: 120, sourceInFrame: 92,
    sourceInFraction: { numerator: 1, denominator: 2 }, playbackRate: { numerator: 3, denominator: 2 },
    effects: [], staticParameters: { "layout.width": 200, "layout.height": 100 },
    parameterTracks: [track("transform.rotation", [0, 45, 90]),
      track("transform.position.x", [0, 0, 0]), track("transform.position.y", [0, -10, -20])],
  }] }] },
}, null, 2));

let log = "";
const child = spawn(app, ["--remote-debugging-port=0", `--user-data-dir=${join(root, "chromium")}`], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", MPVFX_USER_DATA_DIR: join(root, "data"),
    MPVFX_HIDDEN_TEST_WINDOW: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", chunk => { log += chunk; });
child.stderr.on("data", chunk => { log += chunk; });
let browser;
const waitFor = async (read, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    if (child.exitCode !== null) throw new Error(`App exited: ${log.slice(-2000)}`);
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${log.slice(-2000)}`);
};
const documentState = async () => JSON.parse(await readFile(nativePath, "utf8"));
const clipOf = document => document.sequence.tracks[0].clips[0];
const keyValues = (clip, parameterId) => clip.parameterTracks
  .find(item => item.parameterId === parameterId).keyframes.map(key => key.value);

try {
  const endpoint = await waitFor(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const page = await (await browser.waitForTarget(target => target.url().startsWith("mpvfx://editor/"),
    { timeout: 30000 })).page();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  const frame = await waitFor(() => page.frames().find(item => item.url().includes("/api/projects/MpVFX/preview")));
  await waitFor(async () => frame.$("#crop-clip"));
  // Seek through the editor ruler so its edit-time store follows playback.
  await page.mouse.click(295.4, 586);
  // The ruler accepts subframe pointer positions; use frame steps to land on
  // the exact authored key without relying on a particular window width.
  for (let attempt = 0; attempt < 5; attempt++) {
    const time = await page.evaluate(() => document.querySelector("hyperframes-player")?.currentTime);
    if (Math.abs(time - 1.5) < 0.01) break;
    await page.keyboard.press(time < 1.5 ? "ArrowRight" : "ArrowLeft");
    await new Promise(done => setTimeout(done, 100));
  }
  const editTime = await page.evaluate(() => document.querySelector("hyperframes-player")?.currentTime);
  if (Math.abs(editTime - 1.5) >= 0.01) throw new Error(`Could not seek exact key frame: ${editTime}`);
  const initial = await documentState();
  const imageBox = await (await frame.$("#crop-clip")).boundingBox();
  await page.mouse.click(imageBox.x + imageBox.width / 2, imageBox.y + imageBox.height / 2);
  const rotate = await page.waitForSelector('[data-testid="isolated-preview-rotate"]', { timeout: 10000 });
  const enabled = await waitFor(async () => rotate.evaluate(node => !node.disabled), 2500).catch(() => false);
  if (!enabled) {
    const observed = await frame.evaluate(() => { const el = document.getElementById("crop-clip"); const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return { handle: "e1", tag: "img", id: el.id, className: "", text: "", textEditable: false,
        visible: true, parent: null, sourceFile: "index.html", compositionPath: "index.html",
        selector: "#crop-clip", dataAttributes: Object.fromEntries([...el.attributes]
          .filter(attr => attr.name.startsWith("data-")).map(attr => [attr.name.slice(5), attr.value])),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        inlineStyles: { "clip-path": el.style.clipPath },
        computedStyles: { width: style.width, height: style.height, transform: style.transform,
          "transform-origin": style.transformOrigin, "clip-path": style.clipPath } }; });
    await writeFile(join(root, "disabled-state.json"), JSON.stringify({ observed,
      document: await documentState() }, null, 2));
    const info = { playerTime: await page.evaluate(() => document.querySelector("hyperframes-player")?.currentTime),
      title: await rotate.evaluate(node => node.title),
      pose: await frame.evaluate(() => { const el = document.getElementById("crop-clip"); const style = getComputedStyle(el);
        return { transform: style.transform, origin: style.transformOrigin, crop: style.clipPath,
          width: style.width, height: style.height }; }) };
    throw new Error(`Animated cropped rotation was disabled at a saved key: ${JSON.stringify(info)}`);
  }
  const handle = await rotate.boundingBox();
  const visible = await page.$eval('[data-testid="isolated-preview-visible-selection"]', node => {
    const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const center = { x: visible.x + visible.width / 2, y: visible.y + visible.height / 2 };
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(center.x + 70, center.y - 70, { steps: 8 });
  await page.mouse.up();
  const saved = await waitFor(async () => {
    const document = await documentState();
    const values = keyValues(clipOf(document), "transform.rotation");
    return document.revision > initial.revision && values[1] > 60 ? document : null;
  }, 10000);
  const clip = clipOf(saved);
  if (keyValues(clip, "transform.rotation")[0] !== 0 || keyValues(clip, "transform.rotation")[2] !== 90 ||
    clip.cropPivotSegments?.length !== 2 || clip.sourceInFraction?.numerator !== 1 ||
    clip.sourceInFraction?.denominator !== 2 || clip.playbackRate?.numerator !== 3) {
    throw new Error("Animated crop edit changed adjacent keys or fractional source timing");
  }
  await page.screenshot({ path: join(root, "animated-crop-saved.png") });
  await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");
  await waitFor(async () => keyValues(clipOf(await documentState()), "transform.rotation")[1] === 45);
  await page.keyboard.down("Meta"); await page.keyboard.down("Shift"); await page.keyboard.press("z");
  await page.keyboard.up("Shift"); await page.keyboard.up("Meta");
  await waitFor(async () => keyValues(clipOf(await documentState()), "transform.rotation")[1] > 60);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  const reopened = await waitFor(async () => {
    const current = page.frames().find(item => item.url().includes("/api/projects/MpVFX/preview"));
    return current && await current.$("#crop-clip") ? current : null;
  });
  await page.evaluate(() => document.querySelector("hyperframes-player").seek(1.5));
  await waitFor(async () => Math.abs((await page.evaluate(() =>
    document.querySelector("hyperframes-player")?.currentTime)) - 1.5) < 0.05);
  const live = await reopened.evaluate(() => getComputedStyle(document.getElementById("crop-clip")).transform);
  if (!/^matrix\(/.test(live)) throw new Error("Animated crop pose was not restored after reopen");
  await page.screenshot({ path: join(root, "animated-crop-reopened.png") });
  const evidence = { root, rotationKeys: keyValues(clip, "transform.rotation"),
    xKeys: keyValues(clip, "transform.position.x"), yKeys: keyValues(clip, "transform.position.y"),
    cropPivotSegments: clip.cropPivotSegments, fractionalSource: clip.sourceInFraction,
    playbackRate: clip.playbackRate, liveTransform: live };
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  browser?.disconnect(); child.kill("SIGTERM");
  await writeFile(join(root, "app.log"), log);
}
