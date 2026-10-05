// Native canvas gesture QA in a packaged app with a disposable project/profile.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const app = resolve(process.env.MPVFX_PACKAGED_APP ?? "out/MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX");
const root = await mkdtemp(join(tmpdir(), "mpvfx-preview-gestures-"));
const project = join(root, "data/projects/MpVFX");
await mkdir(join(project, ".studio"), { recursive: true });
await writeFile(join(project, "transparent.png"), Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64"));
await writeFile(join(project, "index.html"), `<!doctype html><html><head><meta charset="utf-8"></head><body>
<main data-composition-id="main" data-width="640" data-height="360" data-duration="4"
  style="position:relative;width:640px;height:360px;background:white">
  <img id="clip-a" class="clip" data-hf-id="hf-a" data-studio-clip-id="clip:a" data-start="0" data-duration="4"
    src="transparent.png" style="position:absolute;left:80px;top:80px;width:170px;height:100px;background:#e22626">
  <img id="clip-b" class="clip" data-hf-id="hf-b" data-studio-clip-id="clip:b" data-start="0" data-duration="4"
    src="transparent.png" style="position:absolute;left:320px;top:80px;width:170px;height:100px;background:#2469bd">
</main></body></html>`);
const nativePath = join(project, ".studio/project.json");
const makeClip = (suffix, domId) => ({ id: `clip:${suffix}`, assetId: `asset:${suffix}`,
  binding: { sourceFile: "index.html", domId, hfId: `hf-${suffix}` },
  startFrame: 0, durationFrames: 120, sourceInFrame: 0,
  effects: [], parameterTracks: [] });
await writeFile(nativePath, JSON.stringify({
  schemaVersion: 1, id: "project:MpVFX", revision: 0,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 640, height: 360, background: "#ffffff" },
  assets: ["a", "b"].map(suffix => ({ id: `asset:${suffix}`, kind: "image",
    name: `Clip ${suffix}`, source: "transparent.png", durationFrames: 120 })),
  sequence: { id: "sequence:main", name: "Main", tracks: [{ id: "track:one", kind: "mixed",
    clips: [makeClip("a", "clip-a"), makeClip("b", "clip-b")] }] },
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
const readNative = async () => JSON.parse(await readFile(nativePath, "utf8"));
const positions = document => document.sequence.tracks[0].clips.map(clip => ({
  id: clip.id, x: clip.staticParameters?.["transform.position.x"] ?? 0,
  y: clip.staticParameters?.["transform.position.y"] ?? 0,
}));
const bounds = async (frame, selector) => {
  const element = await frame.$(selector);
  return element?.boundingBox() ?? null;
};

try {
  const endpoint = await waitFor(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const page = await (await browser.waitForTarget(target => target.url().startsWith("mpvfx://editor/"),
    { timeout: 30000 })).page();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  const preview = await waitFor(() => page.frames().find(frame => frame.url().includes("/api/projects/MpVFX/preview")));
  const a = await waitFor(() => bounds(preview, "#clip-a"));
  const b = await waitFor(() => bounds(preview, "#clip-b"));
  const before = { a, b };
  await page.screenshot({ path: join(root, "gestures-before.png") });

  // Start on empty canvas so the overlay owns the marquee pointer capture.
  const left = a.x - 15;
  const top = a.y - 20;
  const right = b.x + b.width + 15;
  const bottom = b.y + b.height + 20;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 12 });
  await page.mouse.up();
  const groupSelected = await waitFor(() => page.evaluate(() =>
    document.querySelectorAll('[data-testid="isolated-preview-selection"]').length === 1 &&
    document.querySelectorAll('[aria-label="Isolated composition canvas"] .border-studio-accent\\/70').length >= 1), 10000);
  if (!groupSelected) throw new Error("The marquee did not select both clips");
  await page.screenshot({ path: join(root, "gestures-marquee.png") });

  const selected = await page.$eval('[data-testid="isolated-preview-selection"]', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(selected.x, selected.y);
  await page.mouse.down();
  await page.mouse.move(selected.x + 30, selected.y + 20, { steps: 6 });
  await page.mouse.up();
  const grouped = await waitFor(async () => {
    const document = await readNative();
    return positions(document).every(clip => clip.x > 20 && clip.y > 10) ? document : null;
  }, 10000);
  const groupPositions = positions(grouped);
  await page.keyboard.down("Meta");
  await page.keyboard.press("z");
  await page.keyboard.up("Meta");
  await waitFor(async () => positions(await readNative()).every(clip => clip.x === 0 && clip.y === 0), 10000);
  await page.keyboard.down("Meta");
  await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
  await waitFor(async () => positions(await readNative()).every(clip => clip.x > 20 && clip.y > 10), 10000);
  await page.screenshot({ path: join(root, "gestures-group-moved.png") });

  // Select only A after the group move; resize its lower-right handle.
  const movedA = await waitFor(async () => {
    const box = await bounds(preview, "#clip-a");
    return box && box.x > a.x + 20 ? box : null;
  }, 10000);
  await page.mouse.click(movedA.x + movedA.width / 2, movedA.y + movedA.height / 2);
  const resize = await page.waitForSelector('[data-testid="isolated-preview-resize"]', { timeout: 10000 });
  await waitFor(() => page.$eval('[data-testid="isolated-preview-resize"]', element => !element.disabled), 10000);
  const resizeBox = await resize.boundingBox();
  const resizeX = resizeBox.x + resizeBox.width / 2;
  const resizeY = resizeBox.y + resizeBox.height / 2;
  await page.mouse.move(resizeX, resizeY);
  await page.mouse.down();
  await page.mouse.move(resizeX + 30, resizeY + 15, { steps: 5 });
  await page.mouse.up();
  const resized = await waitFor(async () => {
    const document = await readNative();
    const clip = document.sequence.tracks[0].clips.find(candidate => candidate.id === "clip:a");
    return clip?.staticParameters?.["layout.width"] > 185 && clip.staticParameters?.["layout.height"] > 105
      ? document : null;
  }, 10000);
  await page.screenshot({ path: join(root, "gestures-resized.png") });

  const rotate = await page.waitForSelector('[data-testid="isolated-preview-rotate"]', { timeout: 10000 });
  await waitFor(() => page.$eval('[data-testid="isolated-preview-rotate"]', element => !element.disabled), 10000);
  await page.evaluate(() => {
    window.__gestureTrace = [];
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
      document.addEventListener(type, event => {
        const target = event.target;
        window.__gestureTrace.push({ type, x: event.clientX, y: event.clientY,
          target: target?.getAttribute?.("data-testid") ?? target?.getAttribute?.("aria-label") ?? target?.tagName,
          rotateDisabled: document.querySelector('[data-testid="isolated-preview-rotate"]')?.disabled,
          rotateRect: document.querySelector('[data-testid="isolated-preview-rotate"]')?.getBoundingClientRect().toJSON() });
      }, true);
    }
  });
  const rotateBox = await rotate.boundingBox();
  const selectedBox = await page.$eval('[data-testid="isolated-preview-selection"]', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.mouse.move(rotateBox.x + rotateBox.width / 2, rotateBox.y + rotateBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(selectedBox.x + selectedBox.width + 40,
    selectedBox.y + selectedBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.screenshot({ path: join(root, "gestures-rotation-attempt.png") });
  const rotationAttempt = { start: { rotateBox, selectedBox },
    native: (await readNative()).sequence.tracks[0].clips[0].staticParameters,
    editor: await page.evaluate(() => {
      const handle = document.querySelector('[data-testid="isolated-preview-rotate"]');
      const selected = document.querySelector('[data-testid="isolated-preview-selection"]');
      return { trace: window.__gestureTrace, handleDisabled: handle?.disabled, handleRect: handle?.getBoundingClientRect().toJSON(),
        selectedRect: selected?.getBoundingClientRect().toJSON(),
        notices: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent) };
    }) };
  await writeFile(join(root, "rotation-attempt.json"), JSON.stringify(rotationAttempt, null, 2));
  const rotated = await waitFor(async () => {
    const document = await readNative();
    const clip = document.sequence.tracks[0].clips.find(candidate => candidate.id === "clip:a");
    const angle = clip?.staticParameters?.["transform.rotation"] ?? 0;
    return angle > 45 && angle < 135 ? document : null;
  }, 10000);
  await page.screenshot({ path: join(root, "gestures-rotated.png") });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  const reopened = await waitFor(() => page.frames().find(frame =>
    frame.url().includes("/api/projects/MpVFX/preview")));
  const afterA = await waitFor(() => bounds(reopened, "#clip-a"));
  const afterB = await waitFor(() => bounds(reopened, "#clip-b"));
  const visual = await reopened.evaluate(() => ({
    a: document.getElementById("clip-a")?.style.transform,
    b: document.getElementById("clip-b")?.style.transform,
    aWidth: getComputedStyle(document.getElementById("clip-a")).width,
  }));
  await page.screenshot({ path: join(root, "gestures-reopened.png") });
  const evidence = { root, before, groupPositions, resizedWidth: resized.sequence.tracks[0].clips[0].staticParameters["layout.width"],
    rotation: rotated.sequence.tracks[0].clips[0].staticParameters["transform.rotation"],
    afterA, afterB, visual, revision: (await readNative()).revision };
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  if (!(afterA.x > a.x + 20 && afterB.x > b.x + 20 && afterA.height > a.height + 50 &&
    visual.a?.includes("rotate(90") && Number.parseFloat(visual.aWidth) > 185)) {
    throw new Error("One or more native gestures did not survive packaged preview reopen");
  }
} finally {
  browser?.disconnect();
  child.kill("SIGTERM");
  await writeFile(join(root, "app.log"), log);
}
