// Packaged legacy-only GSAP parity QA. Every project/profile here is disposable.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const app = resolve(process.env.MPVFX_PACKAGED_APP ?? "out/MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX");
const root = await mkdtemp(join(tmpdir(), "mpvfx-preview-gsap-parity-"));
const data = join(root, "data");
const html = tween => `<!doctype html><html><head><script src="vendor/gsap.min.js"></script></head><body>
<main data-composition-id="main" data-width="640" data-height="360" data-duration="4">
<div id="attack-clip" data-hf-id="hf-attack" data-start="0" data-duration="4"
 style="position:absolute;left:80px;top:80px;width:200px;height:100px;background:#2469bd">Fixture</div>
</main><script>window.__timelines=window.__timelines||{};
const tl=gsap.timeline({paused:true});window.__timelines.main=tl;${tween}</script></body></html>`;
const fixtures = {
  Move: 'tl.to("#attack-clip",{x:100,duration:4,ease:"none"},0);',
  Keyed: 'tl.to("#attack-clip",{duration:4,ease:"none",keyframes:{"0%":{x:0},"100%":{x:100}}},0);',
  New: "",
};
for (const [name, tween] of Object.entries(fixtures)) {
  const path = join(data, "projects", name);
  await mkdir(join(path, "vendor"), { recursive: true });
  await writeFile(join(path, "index.html"), html(tween));
  await writeFile(join(path, "vendor", "gsap.min.js"),
    await readFile(resolve("node_modules/gsap/dist/gsap.min.js")));
}
let log = "";
const child = spawn(app, ["--remote-debugging-port=0", `--user-data-dir=${join(root, "chromium")}`], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", MPVFX_USER_DATA_DIR: data,
    MPVFX_HIDDEN_TEST_WINDOW: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", chunk => { log += chunk; });
child.stderr.on("data", chunk => { log += chunk; });
let browser;
const waitFor = async (read, timeout = 15000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    if (child.exitCode !== null) throw new Error(`App exited: ${log.slice(-1500)}`);
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timeout: ${log.slice(-1500)}`);
};
const source = name => readFile(join(data, "projects", name, "index.html"), "utf8");
const sourceStylePx = async (name, property) => Number(
  new RegExp(`${property}:([\\d.]+)px`).exec(await source(name))?.[1] ?? NaN);
const frameFor = (page, name) => page.frames().find(frame =>
  frame.url().includes(`/api/projects/${name}/preview`));
const open = async (page, name) => {
  await page.evaluate(project => { location.hash = `#project/${project}`; }, name);
  await waitFor(async () => {
    const frame = frameFor(page, name);
    return frame && await frame.$("#attack-clip") ? frame : null;
  });
};
const select = async (page, name) => {
  const frame = await waitFor(() => frameFor(page, name));
  const box = await waitFor(async () => (await frame.$("#attack-clip"))?.boundingBox());
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector('[data-testid="remote-inspector"]');
};
const animationSection = '[aria-label="Authored animations"]';
const load = async (page, name) => {
  await select(page, name);
  await page.click(`${animationSection} button`);
  await page.waitForSelector('[aria-label="Animation"]');
};
const replaceNumber = async (page, selector, value) => {
  await page.click(selector);
  await page.keyboard.press("End");
  for (let index = 0; index < 16; index++) await page.keyboard.press("Backspace");
  await page.keyboard.type(String(value));
  const actual = await page.$eval(selector, element => element.value);
  if (actual !== String(value)) throw new Error(`${selector} has ${actual}, expected ${value}`);
};
const seekX = async (page, name, expected) => {
  try { return await waitFor(async () => {
  const frame = frameFor(page, name);
  if (!frame) return null;
  const ready = await frame.evaluate(() => Boolean(window.__timelines?.main && document.getElementById("attack-clip")))
    .catch(() => false);
  if (!ready) return null;
  await page.evaluate(() => document.querySelector("hyperframes-player")?.seek(2));
  const x = await frame.evaluate(() => Number(window.gsap?.getProperty?.(
    document.getElementById("attack-clip"), "x"))).catch(() => NaN);
  return Number.isFinite(x) && Math.abs(x - expected) < 2 ? x : null;
  }); } catch (error) {
    const frame = frameFor(page, name);
    const state = frame ? await frame.evaluate(() => ({
      gsap: typeof window.gsap, x: window.gsap?.getProperty?.(document.getElementById("attack-clip"), "x"),
      children: window.__timelines?.main?.getChildren?.(true)?.map(child => child.vars),
      time: window.__timelines?.main?.time?.(),
    })).catch(() => null) : null;
    throw new Error(`Seek ${name} expected ${expected}, observed ${JSON.stringify(state)}; ${error}`);
  }
};

try {
  const endpoint = await waitFor(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const page = await (await browser.waitForTarget(target => target.url().startsWith("mpvfx://editor/"),
    { timeout: 30000 })).page();
  await page.setViewport({ width: 1440, height: 900 });

  await open(page, "Move");
  await seekX(page, "Move", 50);
  await select(page, "Move");
  let box = await page.$('[data-testid="isolated-preview-selection"]');
  let bounds = await box.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2 + 10, { steps: 5 });
  await page.mouse.up();
  await waitFor(async () => Math.abs(await sourceStylePx("Move", "left") - 100) < 1 &&
    Math.abs(await sourceStylePx("Move", "top") - 90) < 1);
  await page.screenshot({ path: join(root, "legacy-move-saved.png") });
  await seekX(page, "Move", 50);
  await select(page, "Move");
  box = await page.$('[data-testid="isolated-preview-resize"]');
  bounds = await box.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 30, bounds.y + bounds.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await waitFor(async () => Math.abs(await sourceStylePx("Move", "width") - 230) < 1 &&
    Math.abs(await sourceStylePx("Move", "height") - 120) < 1);
  await page.screenshot({ path: join(root, "legacy-resize-saved.png") });

  await open(page, "Keyed");
  await seekX(page, "Keyed", 50);
  await load(page, "Keyed");
  await replaceNumber(page, '[aria-label="Keyframe position"]', 50);
  await replaceNumber(page, '[aria-label="Keyframe value"]', 75);
  await page.evaluate(() => [...document.querySelectorAll('[aria-label="Authored animations"] button')]
    .find(button => button.textContent?.trim() === "Add keyframe")?.click());
  await waitFor(async () => (await source("Keyed")).includes('"50%"'));
  await seekX(page, "Keyed", 75);
  await page.screenshot({ path: join(root, "legacy-keyframe-saved.png") });
  await load(page, "Keyed");
  await replaceNumber(page, '[aria-label="Keyframe position"]', 50);
  await page.evaluate(() => [...document.querySelectorAll('[aria-label="Authored animations"] button')]
    .find(button => button.textContent?.trim() === "Remove keyframe")?.click());
  await waitFor(async () => !(await source("Keyed")).includes('"50%"'));
  await seekX(page, "Keyed", 50);

  await open(page, "New");
  await select(page, "New");
  await replaceNumber(page, '[aria-label="New animation value"]', 60);
  await page.evaluate(() => [...document.querySelectorAll('[aria-label="Authored animations"] button')]
    .find(button => button.textContent?.trim() === "Add animation")?.click());
  await waitFor(async () => /x:\s*60/.test(await source("New")));
  await load(page, "New");
  await page.evaluate(() => [...document.querySelectorAll('[aria-label="Authored animations"] button')]
    .find(button => button.textContent?.trim() === "Remove animation")?.click());
  await waitFor(async () => !/\.to\("#attack-clip"/.test(await source("New")));

  const evidence = { root,
    moved: { left: await sourceStylePx("Move", "left"), top: await sourceStylePx("Move", "top") },
    resized: { width: await sourceStylePx("Move", "width"), height: await sourceStylePx("Move", "height") },
    keyframeRemoved: !(await source("Keyed")).includes('"50%"'),
    animationRemoved: !/\.to\("#attack-clip"/.test(await source("New")) };
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  browser?.disconnect();
  child.kill("SIGTERM");
  await writeFile(join(root, "app.log"), log);
}
