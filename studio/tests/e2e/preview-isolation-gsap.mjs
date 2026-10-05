// Packaged macOS QA with a disposable profile and a single authored GSAP tween.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const app = resolve(process.env.MPVFX_PACKAGED_APP ?? "out/MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX");
const root = await mkdtemp(join(tmpdir(), "mpvfx-preview-gsap-"));
const project = join(root, "data/projects/MpVFX");
await mkdir(project, { recursive: true });
const sourcePath = join(project, "index.html");
await writeFile(sourcePath, `<!doctype html><html><head><meta charset="utf-8">
<script src="vendor/gsap.min.js"></script></head><body>
<main data-composition-id="main" data-width="640" data-height="360" data-duration="4">
<div id="attack-clip" class="clip" data-hf-id="hf-attack" data-start="0" data-duration="4"
 style="position:absolute;left:80px;top:80px;width:200px;height:100px;background:#2469bd">Preview fixture</div>
</main><script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
window.__timelines.main = tl;
tl.to('#attack-clip', { x: 100, duration: 4, ease: 'none' }, 0);
</script></body></html>`);

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
const sourceX = async () => {
  const source = await readFile(sourcePath, "utf8");
  return Number(/\bx\s*:\s*(-?\d+(?:\.\d+)?)/.exec(source)?.[1] ?? Number.NaN);
};
const currentPreview = page => page.frames().find(frame =>
  frame.url().includes("/api/projects/MpVFX/preview"));
const seekX = async (page, time, expected) => {
  try { return await waitFor(async () => {
    const frame = currentPreview(page);
    if (!frame) return null;
    const prepared = await frame.evaluate(target => {
      const element = document.getElementById("attack-clip");
      const tween = window.__timelines?.main?.getChildren?.(true)?.[0];
      return Boolean(element && window.gsap && tween && Math.abs(Number(tween.vars?.x) - target) < 1);
    }, expected * 2).catch(() => false);
    if (!prepared) return null;
    await page.evaluate(seconds => document.querySelector("hyperframes-player")?.seek(seconds), time);
    const value = await frame.evaluate(() => {
      const element = document.getElementById("attack-clip");
      return element && window.gsap ? Number(window.gsap.getProperty(element, "x")) : null;
    }).catch(() => null);
    return typeof value === "number" && Number.isFinite(value) &&
      Math.abs(value - expected) < 5 ? value : null;
  }, 10000); }
  catch (error) {
    const frame = currentPreview(page);
    const state = frame ? await frame.evaluate(() => ({
      gsap: typeof window.gsap,
      timelineTime: window.__timelines?.main?.time?.(),
      authoredX: window.__timelines?.main?.getChildren?.(true)?.[0]?.vars?.x,
      x: window.gsap?.getProperty?.(document.getElementById("attack-clip"), "x"),
      playerTime: window.__player?.getTime?.(),
    })) : null;
    throw new Error(`GSAP seek expected x=${expected}, got ${JSON.stringify(state)}; ${error}`);
  }
};
const keyboardUndo = async (page, redo = false) => {
  await page.keyboard.down("Meta");
  if (redo) await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  if (redo) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};

try {
  const endpoint = await waitFor(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const page = await (await browser.waitForTarget(target => target.url().startsWith("mpvfx://editor/"),
    { timeout: 30000 })).page();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  const preview = await waitFor(() => currentPreview(page));
  const clip = await waitFor(async () => {
    const element = await preview.$("#attack-clip");
    return element && await element.boundingBox() ? element : null;
  });
  const initialSource = await sourceX();
  if (initialSource !== 100) throw new Error(`Unexpected fixture GSAP x=${initialSource}`);
  await page.evaluate(() => document.querySelector("hyperframes-player")?.seek(2));
  const initialRuntime = await seekX(page, 2, 50);
  const box = await clip.boundingBox();
  await preview.evaluate(() => {
    window.__gsapRequestTrace = [];
    window.addEventListener("message", event => {
      if (event.data?.channel !== "mpvfx.preview-agent" || event.data?.type !== "request") return;
      window.__gsapRequestTrace.push({ id: event.data.id, kind: event.data.command?.kind,
        offset: event.data.command?.offset, limit: event.data.command?.limit });
    }, true);
  });
  const pointerTarget = await page.evaluate(({ x, y }) => {
    window.__gsapPointerTrace = [];
    window.__gsapAgentTrace = [];
    window.__gsapSelectionTrace = [];
    window.addEventListener("mpvfx-isolated-preview-selection", event => {
      window.__gsapSelectionTrace.push({ type: "selection", handle: event.detail?.state?.handle,
        id: event.detail?.state?.id, sourceFile: event.detail?.state?.sourceFile,
        iframeMatches: event.detail?.iframe === document.querySelector("hyperframes-player")?.iframeElement });
    }, true);
    document.querySelector("hyperframes-player")?.iframeElement?.addEventListener("load", () => {
      window.__gsapSelectionTrace.push({ type: "iframe-load" });
    }, true);
    window.addEventListener("message", event => {
      if (event.data?.channel !== "mpvfx.preview-agent") return;
      window.__gsapAgentTrace.push({ type: event.data.type, id: event.data.id,
        ok: event.data.ok, error: event.data.error,
        result: Array.isArray(event.data.result) ? event.data.result.map(item => item.id) : event.data.result?.id });
    }, true);
    const overlay = document.querySelector('[aria-label="Isolated composition canvas"]');
    const hit = document.elementFromPoint(x, y);
    const rect = overlay?.getBoundingClientRect();
    const target = hit && [hit, ...[...document.querySelectorAll("*")].filter(node => node.contains(hit) && node !== hit)
      .reverse().slice(0, 8)].map(node => ({ tag: node.tagName, aria: node.getAttribute("aria-label"),
      testId: node.getAttribute("data-testid"), className: String(node.className).slice(0, 120) }));
    for (const type of ["pointerdown", "pointerup", "click"]) {
      document.addEventListener(type, event => window.__gsapPointerTrace.push({
        type: `document:${type}`, target: event.target?.getAttribute?.("aria-label") || event.target?.tagName,
        x: event.clientX, y: event.clientY,
      }), true);
    }
    for (const type of ["pointerdown", "pointerup", "click"]) {
      overlay?.addEventListener(type, event => window.__gsapPointerTrace.push({
        type, target: event.target?.getAttribute?.("aria-label") || event.target?.tagName,
        currentTarget: event.currentTarget?.getAttribute?.("aria-label"),
        x: event.clientX, y: event.clientY,
      }), true);
    }
    return { target, overlayRect: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  try { await page.waitForSelector('[data-testid="remote-inspector"]', { timeout: 10000 }); }
  catch (error) {
    const diagnostic = await page.evaluate(async ({ x, y, pointerTarget }) => {
      const frame = document.querySelector("hyperframes-player")?.iframeElement;
      const overlay = document.querySelector('[aria-label="Isolated composition canvas"]');
      const fiberKey = overlay && Object.keys(overlay).find(key => key.startsWith("__reactFiber$"));
      let fiber = fiberKey && overlay[fiberKey];
      while (fiber && fiber.type?.name !== "IsolatedPreviewOverlay") fiber = fiber.return;
      const overlayFiber = fiber && { enabled: fiber.memoizedProps?.enabled,
        refMatches: fiber.memoizedProps?.iframeRef?.current === frame,
        refSrc: fiber.memoizedProps?.iframeRef?.current?.src,
        state: (() => { const values = []; let hook = fiber.memoizedState;
          for (let index = 0; hook && index < 8; index++, hook = hook.next) values.push(
            typeof hook.memoizedState === "number" ? hook.memoizedState :
            typeof hook.memoizedState === "boolean" ? hook.memoizedState :
            hook.memoizedState?.handle ?? Array.isArray(hook.memoizedState) ? "array" : null);
          return values; })() };
      const token = "0123456789abcdef0123456789abcdef";
      const origin = frame ? new URL(frame.src).origin : "";
      const request = (message, type, id) => new Promise(resolve => {
        const receive = event => {
          if (event.source !== frame?.contentWindow || event.data?.channel !== "mpvfx.preview-agent" ||
              event.data?.token !== token || event.data?.type !== type ||
              (id && event.data.id !== id)) return;
          window.removeEventListener("message", receive);
          resolve(event.data);
        };
        window.addEventListener("message", receive);
        frame?.contentWindow?.postMessage(message, origin);
        setTimeout(() => { window.removeEventListener("message", receive); resolve("timeout"); }, 1000);
      });
      const init = await request({ channel: "mpvfx.preview-agent", version: 1, type: "init", token }, "ready");
      const snapshot = await request({ channel: "mpvfx.preview-agent", version: 1, type: "request", token,
        id: 1, command: { kind: "snapshot", offset: 0, limit: 300 } }, "reply", 1);
      const frameRect = frame?.getBoundingClientRect();
      const hit = frameRect && await request({ channel: "mpvfx.preview-agent", version: 1,
        type: "request", token, id: 2, command: { kind: "hitTest",
          x: (x - frameRect.left) * (frame.clientWidth || frameRect.width) / frameRect.width,
          y: (y - frameRect.top) * (frame.clientHeight || frameRect.height) / frameRect.height } }, "reply", 2);
      return { overlay: !!overlay, selection: !!document.querySelector('[data-testid="isolated-preview-selection"]'),
        inspector: !!document.querySelector('[data-testid="remote-inspector"]'),
        editorUrl: location.href, overlayFiber, pointerTarget, pointerTrace: window.__gsapPointerTrace,
        agentTrace: window.__gsapAgentTrace, selectionTrace: window.__gsapSelectionTrace,
        init, snapshot, hit };
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2, pointerTarget });
    diagnostic.requestTrace = await currentPreview(page)?.evaluate(() => window.__gsapRequestTrace);
    await writeFile(join(root, "selection-diagnostic.json"), JSON.stringify(diagnostic, null, 2));
    throw new Error(`Legacy selection did not reach inspector; diagnostic: ${join(root, "selection-diagnostic.json")}; ${error}`);
  }
  await page.waitForSelector('[aria-label="Authored animations"]', { timeout: 10000 });
  await page.click('[aria-label="Authored animations"] button');
  try {
    await page.waitForFunction(() => document.querySelector('[aria-label="Animation"]')?.options.length > 0,
      { timeout: 10000 });
  } catch (error) {
    const observation = await page.evaluate(async () => {
      const frame = document.querySelector("hyperframes-player")?.iframeElement;
      if (!frame) return "no-frame";
      const token = "0123456789abcdef0123456789abcdef";
      const origin = new URL(frame.src).origin;
      const request = (id, command) => new Promise(resolve => {
        const receive = event => {
          if (event.source !== frame.contentWindow || event.data?.channel !== "mpvfx.preview-agent" ||
              event.data?.token !== token || event.data?.id !== id || event.data?.type !== "reply") return;
          window.removeEventListener("message", receive);
          resolve(event.data);
        };
        window.addEventListener("message", receive);
        frame.contentWindow.postMessage({ channel: "mpvfx.preview-agent", version: 1,
          type: "request", token, id, command }, origin);
        setTimeout(() => { window.removeEventListener("message", receive); resolve("timeout"); }, 1000);
      });
      frame.contentWindow.postMessage({ channel: "mpvfx.preview-agent", version: 1,
        type: "init", token }, origin);
      await new Promise(done => setTimeout(done, 100));
      const snapshot = await request(1, { kind: "snapshot", offset: 0, limit: 300 });
      const handle = snapshot.result?.find(item => item.id === "attack-clip")?.handle;
      return { snapshot, gsap: handle ? await request(2, { kind: "readGsap", handle,
        channels: ["x", "y", "rotation", "scale", "scaleX", "scaleY", "opacity"] }) : null };
    });
    const diagnostic = {
      inspector: await page.$eval('[data-testid="remote-inspector"]', element => element.innerText),
      notices: await page.evaluate(() => [...document.querySelectorAll('[role="alert"], [role="status"]')]
        .map(element => element.textContent)),
      frames: page.frames().map(frame => frame.url()),
      runtime: await currentPreview(page)?.evaluate(() => JSON.stringify({
        gsap: typeof window.gsap, timelines: Object.keys(window.__timelines ?? {}),
        children: window.__timelines?.main?.getChildren?.(true)?.map(child => ({
          keys: Object.keys(child.vars ?? {}), x: child.vars?.x,
          start: child.startTime?.(), duration: child.duration?.(),
        })),
      })).catch(error => String(error)),
      observation,
      requestTrace: await currentPreview(page)?.evaluate(() => window.__gsapRequestTrace),
    };
    await writeFile(join(root, "diagnostic.json"), JSON.stringify(diagnostic, null, 2));
    throw new Error(`Authored GSAP target did not load; diagnostic: ${join(root, "diagnostic.json")}; ${error}`);
  }
  const available = await page.$eval('[aria-label="Animation"]', select =>
    [...select.options].map(option => ({ value: option.value, text: option.textContent })));
  if (available.length !== 1) throw new Error(`Expected one exact authored tween: ${JSON.stringify(available)}`);
  await page.select('[aria-label="Animation property"]', "x");
  await page.click('[aria-label="Animation value"]');
  await page.keyboard.press("End");
  for (let index = 0; index < 12; index++) await page.keyboard.press("Backspace");
  await page.keyboard.type("150");
  const enteredValue = await page.$eval('[aria-label="Animation value"]', input => input.value);
  if (enteredValue !== "150") throw new Error(`Animation input was not replaced: ${enteredValue}`);
  await page.click('[aria-label="Authored animations"] > div > button');
  await waitFor(async () => (await sourceX()) === 150, 10000);
  const savedRuntime = await seekX(page, 2, 75);
  await page.screenshot({ path: join(root, "gsap-saved.png") });

  await keyboardUndo(page);
  await waitFor(async () => (await sourceX()) === 100, 10000);
  const undoneRuntime = await seekX(page, 2, 50);
  await keyboardUndo(page, true);
  await waitFor(async () => (await sourceX()) === 150, 10000);
  const redoneRuntime = await seekX(page, 2, 75);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  await waitFor(() => currentPreview(page));
  const reopenedRuntime = await seekX(page, 2, 75);
  await page.screenshot({ path: join(root, "gsap-reopened.png") });
  const evidence = { root, initialSource, initialRuntime, savedSource: await sourceX(),
    savedRuntime, undoneRuntime, redoneRuntime, reopenedRuntime, targets: available };
  if (!(savedRuntime > initialRuntime + 15) ||
      !(Math.abs(undoneRuntime - initialRuntime) < 5) ||
      !(Math.abs(redoneRuntime - savedRuntime) < 5) ||
      !(Math.abs(reopenedRuntime - savedRuntime) < 5)) {
    throw new Error(`GSAP source saved but preview/Undo/reopen diverged: ${JSON.stringify(evidence)}`);
  }
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  browser?.disconnect();
  child.kill("SIGTERM");
  await writeFile(join(root, "app.log"), log);
}
