// Packaged macOS QA: isolated preview lane-to-z persistence and one-step Undo/Redo.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const app = resolve(process.env.MPVFX_PACKAGED_APP ?? "out/MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX");
const root = await mkdtemp(join(tmpdir(), "mpvfx-preview-stacking-"));
const project = join(root, "data/projects/MpVFX");
await mkdir(join(project, ".studio"), { recursive: true });
await writeFile(join(project, "index.html"), `<!doctype html><html><body>
<main data-composition-id="main" data-width="640" data-height="360" data-duration="8"
  style="position:relative;width:640px;height:360px;background:white">
  <div id="clip-a" data-hf-id="hf-a" data-studio-clip-id="clip:a" data-start="0" data-duration="4"
    data-track-index="0" style="position:absolute;left:100px;top:80px;width:180px;height:100px;z-index:1;background:#e22626">Clip A</div>
  <div id="clip-b" data-hf-id="hf-b" data-studio-clip-id="clip:b" data-start="0" data-duration="4"
    data-track-index="1" style="position:absolute;left:100px;top:80px;width:180px;height:100px;z-index:2;background:#2469bd">Clip B</div>
  <div id="clip-c" data-hf-id="hf-c" data-studio-clip-id="clip:c" data-start="5" data-duration="2"
    data-track-index="2" style="position:absolute;left:360px;top:80px;width:180px;height:100px;z-index:0;background:#4c9b43">Clip C</div>
</main></body></html>`);
const nativePath = join(project, ".studio/project.json");
const makeClip = (suffix, startFrame, durationFrames) => ({
  id: `clip:${suffix}`, assetId: `asset:${suffix}`,
  binding: { sourceFile: "index.html", domId: `clip-${suffix}`, hfId: `hf-${suffix}` },
  startFrame, durationFrames, sourceInFrame: 0, effects: [], parameterTracks: [],
});
await writeFile(nativePath, JSON.stringify({
  schemaVersion: 1, id: "project:MpVFX", revision: 0,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 640, height: 360, background: "#ffffff" },
  assets: ["a", "b", "c"].map(suffix => ({ id: `asset:${suffix}`, kind: "element",
    name: `Clip ${suffix}`, durationFrames: 240 })),
  sequence: { id: "sequence:main", name: "Main", tracks: [
    { id: "track:a", kind: "mixed", lane: { authoredTrack: 0, displayTrack: 0 }, clips: [makeClip("a", 0, 120)] },
    { id: "track:b", kind: "mixed", lane: { authoredTrack: 1, displayTrack: 1 }, clips: [makeClip("b", 0, 120)] },
    { id: "track:c", kind: "mixed", lane: { authoredTrack: 2, displayTrack: 2 }, clips: [makeClip("c", 150, 60)] },
  ] },
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
let stage = "startup";
let debugPage;
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
const native = async () => JSON.parse(await readFile(nativePath, "utf8"));
const laneOfB = document => document.sequence.tracks.find(track =>
  track.clips.some(clip => clip.id === "clip:b"))?.lane?.authoredTrack;
const sourceZ = async () => /id="clip-b"[^>]*style="[^"]*z-index:\s*(\d+)/
  .exec(await readFile(join(project, "index.html"), "utf8"))?.[1];
const pressUndo = async page => {
  await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");
};
const pressRedo = async page => {
  await page.keyboard.down("Meta"); await page.keyboard.down("Shift");
  await page.keyboard.press("z"); await page.keyboard.up("Shift"); await page.keyboard.up("Meta");
};
const readVisual = async page => {
  const frame = page.frames().find(item => item.url().includes("/api/projects/MpVFX/preview"));
  return frame?.evaluate(() => {
    const a = document.getElementById("clip-a");
    const b = document.getElementById("clip-b");
    if (!a || !b) return null;
    const box = a.getBoundingClientRect();
    return { a: getComputedStyle(a).zIndex, b: getComputedStyle(b).zIndex,
      top: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.id };
  }).catch(error => {
    if (/Execution context was destroyed|detached Frame/i.test(String(error))) return null;
    throw error;
  }) ?? null;
};
try {
  const endpoint = await waitFor(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const page = await (await browser.waitForTarget(target => target.url().startsWith("mpvfx://editor/"),
    { timeout: 30000 })).page();
  debugPage = page;
  await page.setViewport({ width: 1440, height: 1200 });
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  const preview = await waitFor(() => page.frames().find(frame => frame.url().includes("/api/projects/MpVFX/preview")));
  await waitFor(() => page.evaluate(() => document.querySelectorAll('button[data-clip="true"]').length), 15000);
  const rows = await page.evaluate(() => [...document.querySelectorAll('button[data-clip="true"]')]
    .map(button => ({ id: button.getAttribute("data-el-id"), label: button.getAttribute("aria-label"),
      box: button.getBoundingClientRect().toJSON() })));
  const b = rows.find(row => /clip[-:]b/i.test(row.id ?? "") || /clip b/i.test(row.label ?? ""));
  const c = rows.find(row => /clip[-:]c/i.test(row.id ?? "") || /clip c/i.test(row.label ?? ""));
  if (!b || !c) {
    const diagnostic = await page.evaluate(() => {
      const grid = document.querySelector('[aria-label="Timeline tracks"]');
      const chain = [];
      for (let node = grid, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
        chain.push({ tag: node.tagName, className: node.className,
          rect: node.getBoundingClientRect().toJSON(), scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight, clientHeight: node.clientHeight });
      }
      return { viewport: { width: innerWidth, height: innerHeight }, chain,
        store: window.__playerStore?.getState?.().elements?.map(el => ({ id: el.id, key: el.key, track: el.track })) };
    });
    throw new Error(`Missing timeline row: ${JSON.stringify({ rows, diagnostic })}`);
  }
  const before = { lane: laneOfB(await native()), z: await sourceZ(), visual: await readVisual(page) };
  if (before.lane !== 1 || before.z !== "2") throw new Error(`Unexpected fixture: ${JSON.stringify(before)}`);
  if (process.env.MPVFX_STACKING_PROBE_ATTACH === "1") {
    await page.evaluate(() => {
      const iframe = document.querySelector("hyperframes-player")?.iframeElement;
      window.dispatchEvent(new CustomEvent("mpvfx-preview-agent-attached", { detail: iframe }));
    });
    await new Promise(done => setTimeout(done, 500));
  }
  stage = "drag";
  await page.mouse.move(b.box.x + Math.min(40, b.box.width / 2), b.box.y + b.box.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.box.x + Math.min(40, b.box.width / 2), c.box.y + c.box.height / 2, { steps: 12 });
  await page.mouse.up();
  stage = "persist";
  const moved = await waitFor(async () => {
    const lane = laneOfB(await native());
    const z = await sourceZ();
    return lane === 2 && Number(z) < 1 ? { lane, z } : null;
  }, 5000);
  const interimVisuals = [];
  const visual = await waitFor(async () => {
    const state = await readVisual(page);
    if (state && (interimVisuals.length === 0 || JSON.stringify(state) !== JSON.stringify(interimVisuals.at(-1)))) {
      interimVisuals.push(state);
    }
    return state && Number(state.b) < Number(state.a) && state.top === "clip-a" ? state : null;
  }, 10000).catch(error => { throw new Error(`Visual order did not change: ${JSON.stringify(interimVisuals)}; ${error}`); });
  await pressUndo(page);
  stage = "undo";
  const undone = await waitFor(async () => {
    const lane = laneOfB(await native()); const z = await sourceZ();
    return lane === 1 && z === "2" ? { lane, z } : null;
  }, 10000);
  const undoVisual = await waitFor(async () => {
    const state = await readVisual(page);
    return state?.b === "2" && state.top === "clip-b" ? state : null;
  }, 10000);
  await pressRedo(page);
  stage = "redo";
  const redone = await waitFor(async () => {
    const lane = laneOfB(await native()); const z = await sourceZ();
    return lane === 2 && Number(z) < 1 ? { lane, z } : null;
  }, 10000);
  const redoVisual = await waitFor(async () => {
    const state = await readVisual(page);
    return state && Number(state.b) < Number(state.a) && state.top === "clip-a" ? state : null;
  }, 10000);
  await page.reload({ waitUntil: "domcontentloaded" });
  stage = "reopen";
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  const reopened = await waitFor(async () => {
    const state = await readVisual(page);
    return state && Number(state.b) < Number(state.a) && state.top === "clip-a" ? state : null;
  });
  console.log(JSON.stringify({ root, before, moved, interimVisuals, visual,
    undone, undoVisual, redone, redoVisual, reopened }));
} catch (error) {
  const diagnostic = await debugPage?.evaluate(() => ({
    rows: [...document.querySelectorAll('button[data-clip="true"]')].map(button => ({
      id: button.getAttribute("data-el-id"), rect: button.getBoundingClientRect().toJSON() })),
    notices: [...document.querySelectorAll('[role="alert"], [role="status"]')].map(node => node.textContent),
    react: (() => {
      const root = document.getElementById("root");
      const key = Object.keys(root ?? {}).find(name => name.startsWith("__reactContainer$"));
      const stack = [(key && root[key]?.stateNode?.current) ?? (key && root?.[key])];
      const found = [];
      const names = [];
      for (let scanned = 0; stack.length && scanned < 30000; scanned++) {
        const node = stack.pop();
        if (!node) continue;
        if (names.length < 30) names.push(node.type?.name ?? node.elementType?.name ?? node.tag);
        {
          const refs = [];
          for (let hook = node.memoizedState; hook; hook = hook.next) {
            const value = hook.memoizedState?.current;
            if (Array.isArray(value) && value.some(item => item?.handle?.startsWith?.("e"))) {
              refs.push(value.map(item => ({ id: item.id, source: item.sourceFile,
                native: item.dataAttributes?.["studio-clip-id"], z: item.computedStyles?.["z-index"] })));
            }
          }
          if (refs.length) found.push({ name: node.type?.name, refs });
        }
        stack.push(node.sibling, node.child);
      }
      return { rootKeys: Object.keys(root ?? {}).filter(name => name.startsWith("__react")), names, found };
    })(),
  })).catch(() => null);
  console.error(JSON.stringify({ root, stage, error: String(error),
    lane: await native().then(laneOfB).catch(() => null), z: await sourceZ().catch(() => null),
    diagnostic, log: log.slice(-3000) }));
  process.exitCode = 1;
} finally {
  await browser?.disconnect().catch(() => {});
  child.kill("SIGTERM");
}
