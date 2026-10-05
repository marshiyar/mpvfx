// Packaged Linux or macOS GSAP acceptance with disposable projects and profile.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const app = resolve(process.env.MPVFX_PACKAGED_APP ?? "out/MpVFX-linux-x64/MpVFX");
const root = await mkdtemp(join(tmpdir(), "mpvfx-advanced-gsap-"));
const data = join(root, "data");
const fixtures = {
  From: 'tl.from("#clip",{x:100,duration:4,ease:"none"},0);',
  FromTo: 'tl.fromTo("#clip",{x:10},{x:110,duration:4,ease:"none"},0);',
  Path: 'tl.to("#clip",{duration:4,ease:"none",motionPath:{path:[{x:0,y:0},{x:40,y:80},{x:100,y:0}],curviness:1,autoRotate:false}},0);',
  New: "",
};
const html = tween => `<!doctype html><html><head><script src="vendor/gsap.min.js"></script><script src="vendor/MotionPathPlugin.min.js"></script></head><body>
<main data-composition-id="main" data-width="640" data-height="360" data-duration="4">
<div id="clip" data-hf-id="hf-clip" data-start="0" data-duration="4"
 style="position:absolute;left:80px;top:80px;width:200px;height:100px;background:#2469bd">GSAP fixture</div>
</main><script>gsap.registerPlugin(MotionPathPlugin);window.__timelines=window.__timelines||{};
const tl=gsap.timeline({paused:true});window.__timelines.main=tl;${tween}</script></body></html>`;
for (const [name, tween] of Object.entries(fixtures)) {
  const dir = join(data, "projects", name);
  await mkdir(join(dir, "vendor"), { recursive: true });
  await writeFile(join(dir, "index.html"), html(tween));
  await writeFile(join(dir, "vendor", "gsap.min.js"),
    await readFile(resolve("node_modules/gsap/dist/gsap.min.js")));
  await writeFile(join(dir, "vendor", "MotionPathPlugin.min.js"),
    await readFile(resolve("node_modules/gsap/dist/MotionPathPlugin.min.js")));
}

let log = "";
const child = spawn(app, ["--remote-debugging-port=0", `--user-data-dir=${join(root, "chromium")}`], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", MPVFX_USER_DATA_DIR: data,
    MPVFX_HIDDEN_TEST_WINDOW: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", chunk => { log += chunk; });
child.stderr.on("data", chunk => { log += chunk; });
let browser;
const waitFor = async (read, timeout = 20000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    if (child.exitCode !== null) throw new Error(`App exited: ${log.slice(-2000)}`);
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timeout: ${log.slice(-2000)}`);
};
const source = name => readFile(join(data, "projects", name, "index.html"), "utf8");
const frameFor = (page, name) => page.frames().find(frame =>
  frame.url().includes(`/api/projects/${name}/preview`));
const open = async (page, name) => {
  await page.evaluate(project => { location.hash = `#project/${project}`; }, name);
  await waitFor(async () => {
    const frame = frameFor(page, name);
    return frame && await frame.$("#clip") ? frame : null;
  });
};
const select = async (page, name) => {
  const frame = await waitFor(() => frameFor(page, name));
  const box = await waitFor(async () => (await frame.$("#clip"))?.boundingBox());
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector('[data-testid="remote-inspector"]');
};
const load = async (page, name) => {
  await select(page, name);
  await page.click('[aria-label="Authored animations"] button');
  await page.waitForSelector('[aria-label="Animation"]');
};
const replaceNumber = async (page, selector, value) => {
  await page.click(selector);
  await page.keyboard.press("End");
  for (let index = 0; index < 24; index++) await page.keyboard.press("Backspace");
  await page.keyboard.type(String(value));
  const actual = await page.$eval(selector, element => element.value);
  if (actual !== String(value)) throw new Error(`${selector}: ${actual} != ${value}`);
};
const clickLabel = async (page, label) => page.evaluate(text => {
  const button = [...document.querySelectorAll('[aria-label="Authored animations"] button')]
    .find(item => item.textContent?.trim() === text);
  if (!button) throw new Error(`Missing ${text} button`);
  button.click();
}, label);
const seek = async (page, name, seconds, property, expected, tolerance = 2) => waitFor(async () => {
  const frame = frameFor(page, name);
  if (!frame) return null;
  await page.evaluate(time => document.querySelector("hyperframes-player")?.seek(time), seconds);
  const value = await frame.evaluate(channel => Number(window.gsap?.getProperty?.(
    document.getElementById("clip"), channel)), property).catch(() => NaN);
  return Number.isFinite(value) && Math.abs(value - expected) <= tolerance ? value : null;
});

try {
  const endpoint = await waitFor(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const page = await (await browser.waitForTarget(target => target.url().startsWith("mpvfx://editor/"),
    { timeout: 30000 })).page();
  await page.setViewport({ width: 1440, height: 900 });
  const evidence = { root, checks: {} };

  await open(page, "From");
  evidence.checks.fromBefore = await seek(page, "From", 2, "x", 50);
  await load(page, "From");
  await page.select('[aria-label="Animation easing"]', "sine.in");
  await clickLabel(page, "Save easing");
  await waitFor(async () => /ease:\s*["']sine\.in["']/.test(await source("From")));
  evidence.checks.fromAfter = await seek(page, "From", 2, "x", 70.7107);
  await page.screenshot({ path: join(root, "from-at-2s.png") });

  await open(page, "FromTo");
  evidence.checks.fromToBefore = await seek(page, "FromTo", 2, "x", 60);
  await load(page, "FromTo");
  await replaceNumber(page, '[aria-label="Animation from value"]', 20);
  await clickLabel(page, "Save from value");
  await waitFor(async () => /fromTo\(["']#clip["'],\s*\{\s*x:\s*20\s*\}/.test(await source("FromTo")));
  evidence.checks.fromToAfter = await seek(page, "FromTo", 2, "x", 65);
  await page.screenshot({ path: join(root, "fromto-at-2s.png") });

  await open(page, "Path");
  evidence.checks.pathBefore = await seek(page, "Path", 2, "y", 80, 8);
  await load(page, "Path");
  await page.select('[aria-label="Motion path point"]', "1");
  await replaceNumber(page, '[aria-label="Motion path point Y"]', 100);
  await clickLabel(page, "Save motion point");
  await waitFor(async () => /y:\s*100/.test(await source("Path")));
  evidence.checks.pathAfter = await seek(page, "Path", 2, "y", 100, 8);
  await page.screenshot({ path: join(root, "path-at-2s.png") });

  await open(page, "New");
  await select(page, "New");
  await page.select('[aria-label="New animation method"]', "fromTo");
  await replaceNumber(page, '[aria-label="New animation from value"]', 10);
  await replaceNumber(page, '[aria-label="New animation value"]', 110);
  await replaceNumber(page, '[aria-label="New animation duration"]', 4);
  await page.select('[aria-label="New animation easing"]', "none");
  await clickLabel(page, "Add animation");
  await waitFor(async () => /fromTo\("#clip"/.test(await source("New")));
  evidence.checks.newFromTo = await seek(page, "New", 2, "x", 60);
  await page.screenshot({ path: join(root, "new-fromto-at-2s.png") });
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  browser?.disconnect();
  child.kill("SIGTERM");
  await writeFile(join(root, "app.log"), log);
}
