// Packaged isolated-preview inspector QA. All files and browser state are disposable.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const app = resolve(process.env.MPVFX_PACKAGED_APP ?? "out/MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX");
const root = await mkdtemp(join(tmpdir(), "mpvfx-preview-inspector-parity-"));
const data = join(root, "data");
const project = join(data, "projects", "InspectorParity");
const sourcePath = join(project, "index.html");
const nativeProject = join(data, "projects", "NativeMediaInspector");
const nativeSourcePath = join(nativeProject, "index.html");
const nativeSidecarPath = join(nativeProject, ".studio", "project.json");
await mkdir(project, { recursive: true });
await writeFile(sourcePath, `<!doctype html><html><head><meta charset="utf-8"></head><body>
<main data-composition-id="main" data-width="640" data-height="360" data-duration="4"
 style="position:relative;width:640px;height:360px;background:#ffffff">
<div id="plain-text" data-hf-id="hf-plain" data-start="0" data-duration="4"
 style="position:absolute;left:60px;top:60px;width:240px;height:150px;background-color:#e8edf4;color:#172b4d;font-size:24px">Original plain text</div>
<img id="grade-image" data-hf-id="hf-image" data-start="0" data-duration="4" alt="Grade fixture"
 src="fixture.svg" style="position:absolute;left:355px;top:60px;width:220px;height:150px;object-fit:cover">
</main></body></html>`);
await writeFile(join(project, "fixture.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="150"><rect width="220" height="150" fill="#7495ba"/><circle cx="110" cy="75" r="48" fill="#e4aa67"/></svg>`);
await mkdir(join(nativeProject, ".studio"), { recursive: true });
await writeFile(nativeSourcePath, `<!doctype html><html><body><main data-composition-id="main"
 data-width="640" data-height="360" data-duration="4" style="position:relative;width:640px;height:360px;background:#ffffff">
<video id="media-clip" data-hf-id="hf-media" data-studio-clip-id="clip:media"
 data-start="0" data-duration="4" style="position:absolute;left:130px;top:70px;width:380px;height:210px;background:#58799a"></video>
</main></body></html>`);
await writeFile(nativeSidecarPath, JSON.stringify({
  schemaVersion: 1, id: "project:NativeMediaInspector", revision: 0,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 640, height: 360, background: "#ffffff" },
  assets: [{ id: "asset:media", kind: "video", name: "Media fixture", durationFrames: 300 }],
  sequence: { id: "sequence:main", name: "Main", tracks: [{ id: "track:media", kind: "mixed",
    clips: [{ id: "clip:media", assetId: "asset:media",
      binding: { sourceFile: "index.html", domId: "media-clip", hfId: "hf-media" },
      startFrame: 0, durationFrames: 120, sourceInFrame: 0, effects: [], parameterTracks: [] }] }] },
}, null, 2));

let log = "";
const child = spawn(app, ["--remote-debugging-port=0", `--user-data-dir=${join(root, "chromium")}`], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", MPVFX_USER_DATA_DIR: data,
    MPVFX_HIDDEN_TEST_WINDOW: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", chunk => { log += chunk; });
child.stderr.on("data", chunk => { log += chunk; });
let browser;
let page;
let stage = "startup";
const waitFor = async (read, timeout = 20000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    if (child.exitCode !== null) throw new Error(`App exited: ${log.slice(-2000)}`);
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timeout at ${stage}: ${log.slice(-2000)}`);
};
const source = () => readFile(sourcePath, "utf8");
const native = async () => JSON.parse(await readFile(nativeSidecarPath, "utf8"));
const frame = () => page.frames().find(item => item.url().includes("/api/projects/InspectorParity/preview"));
const rendered = async id => frame()?.evaluate(target => {
  const element = document.getElementById(target);
  if (!element) return null;
  const style = getComputedStyle(element);
  return { text: element.textContent, color: style.color, borderWidth: style.borderTopWidth,
    borderStyle: style.borderTopStyle, borderColor: style.borderTopColor,
    shadow: style.boxShadow, backgroundImage: style.backgroundImage,
    grade: element.getAttribute("data-color-grading") };
}, id).catch(() => null);
const select = async id => {
  const target = await waitFor(async () => frame()?.$( `#${id}` ));
  const box = await waitFor(() => target.boundingBox());
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector('[data-testid="remote-inspector"]');
  await waitFor(() => page.$eval('[data-testid="remote-inspector"] h2',
    (node, selectedId) => node.textContent === `#${selectedId}`, id).catch(() => false));
};
const fill = async (label, value) => {
  const selector = `[aria-label="${label}"]`;
  await page.$eval(selector, (node, next) => {
    const setter = Object.getOwnPropertyDescriptor(node.tagName === "TEXTAREA" ?
      HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
    setter.call(node, next);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  await waitFor(() => page.$eval(selector, (node, next) => node.value === next, value));
};
const undo = async redo => {
  await page.keyboard.down("Meta");
  if (redo) await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  if (redo) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
const clickNamed = async name => page.evaluate(label => {
  const button = [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
  if (!button || button.disabled) throw new Error(`Missing enabled button: ${label}`);
  button.click();
}, name);
const evidence = { root, packagedApp: app, stages: {} };
try {
  const endpoint = await waitFor(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  page = await (await browser.waitForTarget(target => target.url().startsWith("mpvfx://editor/"),
    { timeout: 30000 })).page();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluate(() => { location.hash = "#project/InspectorParity"; });
  await waitFor(() => rendered("plain-text"));
  assert.equal(await stat(join(project, ".studio")).then(() => true, () => false), false);
  evidence.stages.initial = { source: await source(), visual: await rendered("plain-text") };
  await page.screenshot({ path: join(root, "01-before.png") });

  stage = "plain text and design";
  await select("plain-text");
  await fill("Text", "Edited plain text");
  await fill("Color", "#773399");
  await clickNamed("Save design");
  await waitFor(async () => (await source()).includes("Edited plain text") && (await source()).includes("#773399"));
  await waitFor(async () => (await rendered("plain-text"))?.text === "Edited plain text");
  evidence.stages.design = { source: await source(), visual: await rendered("plain-text") };

  stage = "gradient border shadow";
  await select("plain-text");
  await fill("Border color", "#132a55");
  await fill("Border width", "4px");
  await page.select('[aria-label="Border style"]', "solid");
  await fill("Box shadow", "0px 4px 12px #000000");
  await fill("Two color gradient", "linear-gradient(90deg,#ff0000,#0000ff)");
  await clickNamed("Save visual style");
  await waitFor(async () => (await source()).includes("linear-gradient(90deg,#ff0000,#0000ff)"));
  const saved = await waitFor(async () => {
    const state = await rendered("plain-text");
    return state?.borderWidth === "4px" && state?.shadow !== "none" &&
      state?.backgroundImage.includes("linear-gradient") ? state : null;
  });
  evidence.stages.visual = { source: await source(), visual: saved };
  await page.screenshot({ path: join(root, "02-visual-saved.png") });
  await undo(false);
  await waitFor(async () => !(await source()).includes("linear-gradient(90deg,#ff0000,#0000ff)"));
  evidence.stages.visualUndo = { source: await source(), visual: await waitFor(async () => {
    const state = await rendered("plain-text"); return state?.backgroundImage === "none" ? state : null;
  }) };
  await undo(true);
  await waitFor(async () => (await source()).includes("linear-gradient(90deg,#ff0000,#0000ff)"));
  evidence.stages.visualRedo = await waitFor(async () => {
    const state = await rendered("plain-text"); return state?.borderWidth === "4px" ? state : null;
  });

  stage = "legacy grade";
  await select("grade-image");
  const preset = await page.$eval('[aria-label="Grade preset"]', node =>
    [...node.options].find(option => option.value === "bright-pop")?.value ??
    [...node.options].find(option => option.value)?.value);
  assert.ok(preset, "No legacy color grade presets");
  await page.select('[aria-label="Grade preset"]', preset);
  await clickNamed("Save color grade");
  await waitFor(async () => (await source()).includes(`&quot;preset&quot;:&quot;${preset}&quot;`) ||
    (await source()).includes(`\\"preset\\":\\"${preset}\\"`) ||
    (await source()).includes(`"preset":"${preset}"`));
  const gradedSource = await source();
  const graded = await waitFor(async () => (await rendered("grade-image"))?.grade);
  assert.match(graded, new RegExp(preset));
  evidence.stages.grade = { preset, source: gradedSource, renderedGrade: graded };
  await select("grade-image");
  await page.$eval('[aria-label="Legacy color grade"]', node => node.scrollIntoView({ block: "center" }));
  evidence.stages.grade.inspectorPresetAfterReselect =
    await page.$eval('[aria-label="Grade preset"]', node => node.value);
  await page.screenshot({ path: join(root, "03-grade-saved.png") });
  await undo(false);
  await waitFor(async () => !(await source()).includes("data-color-grading"));
  evidence.stages.gradeUndo = { source: await source(), renderedGrade: (await waitFor(async () => {
    const state = await rendered("grade-image"); return state?.grade === null ? state : null;
  })).grade };
  await undo(true);
  await waitFor(async () => (await source()).includes("data-color-grading"));
  evidence.stages.gradeRedo = (await waitFor(async () => (await rendered("grade-image"))?.grade)) ?? null;

  stage = "reopen";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => { location.hash = "#project/InspectorParity"; });
  evidence.stages.reopened = { text: await waitFor(async () => (await rendered("plain-text"))?.text),
    grade: await waitFor(async () => (await rendered("grade-image"))?.grade),
    source: await source() };
  assert.equal(evidence.stages.reopened.text, "Edited plain text");
  assert.match(evidence.stages.reopened.grade, new RegExp(preset));
  assert.equal(await stat(join(project, ".studio")).then(() => true, () => false), false);
  await page.screenshot({ path: join(root, "04-reopened.png") });

  stage = "native media";
  await page.evaluate(() => { location.hash = "#project/NativeMediaInspector"; });
  const nativeFrame = () => page.frames().find(item => item.url().includes("/api/projects/NativeMediaInspector/preview"));
  const nativeElement = await waitFor(async () => nativeFrame()?.$("#media-clip"));
  const nativeBox = await waitFor(() => nativeElement.boundingBox());
  await page.mouse.click(nativeBox.x + nativeBox.width / 2, nativeBox.y + nativeBox.height / 2);
  await page.waitForSelector('[aria-label="Native media"]');
  evidence.stages.nativeInitial = { revision: (await native()).revision,
    controls: await page.$eval('[aria-label="Native media"]', section => [...section.querySelectorAll("input,textarea")]
      .map(node => node.getAttribute("aria-label"))) };
  assert.ok(evidence.stages.nativeInitial.controls.includes("Audio gain"));
  await fill("Audio gain", "0.5");
  await page.click('[aria-label="Save Audio gain"]');
  await waitFor(async () => {
    const document = await native();
    return document.revision === 1 && document.sequence.tracks[0].clips[0].staticParameters?.["audio.volume"] === 0.5;
  });
  await waitFor(async () => (await readFile(nativeSourcePath, "utf8")).includes('data-volume="0.5"'));
  evidence.stages.nativeGain = { revision: (await native()).revision,
    gain: (await native()).sequence.tracks[0].clips[0].staticParameters?.["audio.volume"],
    source: await readFile(nativeSourcePath, "utf8") };
  await page.mouse.click(nativeBox.x + nativeBox.width / 2, nativeBox.y + nativeBox.height / 2);
  await page.waitForSelector('[aria-label="Native media"]');
  await page.$eval('[aria-label="Native media"]', node => node.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: join(root, "05-native-gain.png") });
  await undo(false);
  await waitFor(async () => (await native()).revision === 0);
  assert.ok(!(await readFile(nativeSourcePath, "utf8")).includes("data-volume"));
  evidence.stages.nativeUndo = { revision: (await native()).revision,
    source: await readFile(nativeSourcePath, "utf8") };
  await undo(true);
  await waitFor(async () => (await native()).revision === 1);
  assert.ok((await readFile(nativeSourcePath, "utf8")).includes('data-volume="0.5"'));
  evidence.stages.nativeRedo = { revision: (await native()).revision,
    source: await readFile(nativeSourcePath, "utf8") };
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => { location.hash = "#project/NativeMediaInspector"; });
  const reopenedNative = await waitFor(async () => nativeFrame()?.$("#media-clip"));
  const reopenedBox = await waitFor(() => reopenedNative.boundingBox());
  await page.mouse.click(reopenedBox.x + reopenedBox.width / 2, reopenedBox.y + reopenedBox.height / 2);
  await page.waitForSelector('[aria-label="Native media"]');
  evidence.stages.nativeReopened = { revision: (await native()).revision,
    gain: await page.$eval('[aria-label="Audio gain"]', node => node.value),
    source: await readFile(nativeSourcePath, "utf8") };
  assert.equal(evidence.stages.nativeReopened.gain, "0.5");
  await page.$eval('[aria-label="Native media"]', node => node.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: join(root, "06-native-reopened.png") });

  assert.equal(evidence.stages.grade.inspectorPresetAfterReselect, preset,
    "Saved grade must remain selected in the inspector after preview reload/reselection");

  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ root, stages: Object.keys(evidence.stages), preset, result: "PASS" }));
} catch (error) {
  evidence.failure = { stage, message: String(error), stack: error?.stack };
  if (page) await page.screenshot({ path: join(root, "failure.png") }).catch(() => {});
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  throw error;
} finally {
  browser?.disconnect();
  child.kill("SIGTERM");
  await writeFile(join(root, "app.log"), log);
}
