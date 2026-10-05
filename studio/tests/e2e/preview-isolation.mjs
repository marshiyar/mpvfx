// Run against a packaged app with a disposable profile and authored project.
// This checks Chromium's actual frame origins, not a mocked IPC sender.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const app = resolve(process.env.MPVFX_PACKAGED_APP ?? "out/MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX");
const root = await mkdtemp(join(tmpdir(), "mpvfx-preview-isolation-"));
const project = join(root, "data/projects/MpVFX");
await mkdir(join(project, ".studio"), { recursive: true });
await writeFile(join(project, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><script src="vendor/gsap.min.js"></script></head><body>
<main data-composition-id="main" data-width="640" data-height="360" data-duration="4">
  <div id="attack-clip" class="clip" data-hf-id="hf-attack" data-studio-clip-id="clip:attack" data-start="0" data-duration="4"
    style="position:absolute;left:80px;top:80px;width:200px;height:100px;background:#2469bd">Preview fixture</div>
</main>
<script>
  window.__timelines = { main: gsap.timeline({ paused: true }).to('#attack-clip', { x: 100, duration: 4 }, 0) };
  window.__attack = { ran: true };
  try { window.__attack.bridge = top.mpvfx.request({ id: 'attack', path: '/api/projects', method: 'GET', headers: [] }); }
  catch (error) { window.__attack.bridge = error.name; }
  try { window.__attack.parentDom = !!top.document.querySelector('#root'); }
  catch (error) { window.__attack.parentDom = error.name; }
  parent.postMessage({ source: 'preview-isolation-fixture', ...window.__attack }, '*');
</script>
<iframe id="nested-authored" src="/api/projects/MpVFX/preview/nested.html"></iframe>
<iframe id="nested-editor" src="mpvfx://editor/"></iframe>
</body></html>`);
await writeFile(join(project, "nested.html"), `<!doctype html><script>
  window.__nestedAttack = { ran: true };
  try { window.__nestedAttack.bridge = top.mpvfx.request({ id: 'nested', path: '/api/projects', method: 'GET', headers: [] }); }
  catch (error) { window.__nestedAttack.bridge = error.name; }
</script>`);
await writeFile(join(project, ".studio/project.json"), JSON.stringify({
  schemaVersion: 1, id: "project:MpVFX", revision: 0,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 640, height: 360, background: "#ffffff" },
  assets: [{ id: "asset:attack", kind: "element", name: "Preview fixture", durationFrames: 120 }],
  sequence: { id: "sequence:main", name: "Main", tracks: [{ id: "track:one", kind: "mixed",
    clips: [{ id: "clip:attack", assetId: "asset:attack", binding: { sourceFile: "index.html", domId: "attack-clip", hfId: "hf-attack" },
      startFrame: 0, durationFrames: 120, sourceInFrame: 0, effects: [], parameterTracks: [{
        schemaVersion: 1, id: "track:opacity", parameterId: "transform.opacity", valueType: "number",
        frameRate: { numerator: 30, denominator: 1 },
        keyframes: [
          { id: "opacity:start", frame: 0, value: 1, outgoing: { type: "linear" } },
          { id: "opacity:end", frame: 90, value: 0.4, outgoing: { type: "linear" } },
        ],
      }] }] }] },
}, null, 2));

let log = "";
const child = spawn(app, ["--remote-debugging-port=0", `--user-data-dir=${join(root, "chromium")}`], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", MPVFX_USER_DATA_DIR: join(root, "data"), MPVFX_HIDDEN_TEST_WINDOW: "1" },
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
try {
  const endpoint = await waitFor(() => log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const page = await (await browser.waitForTarget(target => target.url().startsWith("mpvfx://editor/"), { timeout: 30000 })).page();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  const preview = await waitFor(() => page.frames().find(frame => frame.url().includes("/api/projects/MpVFX/preview")));
  const attack = await waitFor(async () => preview.evaluate(() => window.__attack ?? null));
  const nested = await waitFor(() => page.frames().find(frame => frame.url().endsWith("/nested.html")));
  const nestedAttack = await waitFor(async () => nested.evaluate(() => window.__nestedAttack ?? null));
  const editorResource = await page.evaluate(async () => (await fetch("/api/projects/MpVFX/preview/nested.html")).status);
  const nestedEditor = await preview.evaluate(() => {
    const frame = document.getElementById("nested-editor");
    try { return frame.contentDocument?.documentElement?.outerHTML.slice(0, 100) ?? null; }
    catch (error) { return error.name; }
  });
  const evidence = { root, previewUrl: preview.url(), attack, nestedAttack, editorResource, nestedEditor };
  const originProbe = await page.evaluate(() => {
    window.__previewOrigins = [];
    window.addEventListener("message", event => {
      if (event.data?.source === "origin-probe") window.__previewOrigins.push(event.origin);
    });
    return location.origin;
  });
  const childOrigin = await preview.evaluate(() => {
    parent.postMessage({ source: "origin-probe" }, "*");
    return location.origin;
  });
  await new Promise(done => setTimeout(done, 250));
  evidence.origins = { editor: originProbe, child: childOrigin,
    message: await page.evaluate(() => window.__previewOrigins) };
  try {
    await page.waitForSelector('[aria-label="Isolated composition canvas"]', { timeout: 10000 });
  } catch (error) {
    evidence.overlayDiagnostic = await page.evaluate(() => ({
      frames: [...document.querySelectorAll("iframe")].map(frame => ({ src: frame.src, accessible: !!frame.contentDocument })),
      players: [...document.querySelectorAll("hyperframes-player")].map(player => ({
        frame: player.iframeElement?.src, accessible: !!player.iframeElement?.contentDocument,
        shadowFrame: player.shadowRoot?.querySelector("iframe")?.src,
      })),
      canvas: !!document.querySelector('[aria-label="Isolated composition canvas"]'),
      design: document.body.innerText.includes("Design"),
    }));
    evidence.previewScripts = await preview.evaluate(() => [...document.scripts].map(script => script.src));
    evidence.clientTrace = await page.evaluate(() => window.__mpvfxPreviewAgentTrace);
    evidence.agentProbe = await page.evaluate(() => new Promise(resolve => {
      const frame = document.querySelector("hyperframes-player")?.iframeElement;
      const token = "0123456789abcdef0123456789abcdef";
      const receive = event => {
        if (event.source !== frame?.contentWindow || event.data?.channel !== "mpvfx.preview-agent") return;
        window.removeEventListener("message", receive);
        resolve({ origin: event.origin, data: event.data });
      };
      window.addEventListener("message", receive);
      frame?.contentWindow?.postMessage({ channel: "mpvfx.preview-agent", version: 1, type: "init", token }, new URL(frame.src).origin);
      setTimeout(() => { window.removeEventListener("message", receive); resolve("timeout"); }, 1000);
    }));
    evidence.reactProbe = await page.evaluate(() => {
      const container = document.getElementById("root");
      const key = Object.keys(container).find(name => name.startsWith("__reactContainer$"));
      const root = key && container[key];
      const found = [];
      const stack = [root?.stateNode?.current ?? root];
      for (let scanned = 0; stack.length && scanned < 50000; scanned++) {
        const node = stack.pop();
        if (!node) continue;
        const name = node.type?.displayName || node.type?.name || node.elementType?.name;
        if (["PreviewOverlays", "IsolatedPreviewOverlay", "NLEPreview"].includes(name) ||
            typeof node.memoizedProps?.shouldShowSelectedDomBounds === "boolean" ||
            (typeof node.memoizedProps?.enabled === "boolean" && node.memoizedProps?.iframeRef)) {
          found.push({ name, enabled: node.memoizedProps?.enabled,
            shouldShowSelectedDomBounds: node.memoizedProps?.shouldShowSelectedDomBounds,
            firstState: node.memoizedState?.memoizedState,
            iframeSrc: node.memoizedProps?.iframeRef?.current?.src });
        }
        stack.push(node.sibling, node.child);
      }
      return found;
    });
    console.error(JSON.stringify(evidence));
    throw error;
  }
  const clip = await preview.$("#attack-clip");
  const clipBox = await clip.boundingBox();
  if (!clipBox) throw new Error("Ordinary authored clip did not render");
  const playbackHost = await waitFor(() => page.evaluate(() => {
    const player = document.querySelector("hyperframes-player");
    return player?.ready && player.duration >= 4;
  }), 10000);
  if (!playbackHost) throw new Error("Isolated player did not become ready");
  await page.evaluate(() => document.querySelector("hyperframes-player").seek(2));
  const seekTime = await waitFor(async () => {
    const time = await page.evaluate(() => document.querySelector("hyperframes-player").currentTime);
    return Math.abs(time - 2) < 0.1 ? time : null;
  }, 10000);
  await page.evaluate(() => document.querySelector("hyperframes-player").play());
  const playingTime = await waitFor(async () => {
    const time = await page.evaluate(() => document.querySelector("hyperframes-player").currentTime);
    return time > seekTime + 0.2 ? time : null;
  }, 10000);
  await page.evaluate(() => document.querySelector("hyperframes-player").pause());
  evidence.playback = { seekTime, playingTime };
  await page.mouse.click(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2);
  await page.waitForSelector('[data-testid="isolated-preview-selection"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="remote-inspector"]', { timeout: 10000 });
  evidence.inspector = await page.$eval('[data-testid="remote-inspector"]', element => ({
    heading: element.querySelector("h2")?.textContent,
    textEditable: !!element.querySelector('textarea[aria-label="Text"]'),
  }));
  await new Promise(done => setTimeout(done, 650));
  evidence.inspector.falseSelectionWarnings = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"], [role="status"]')]
      .filter(element => element.textContent?.includes("not available in the preview yet"))
      .map(element => element.textContent));
  if (evidence.inspector.falseSelectionWarnings.length) {
    throw new Error("Available isolated selection produced a false missing-preview notice");
  }
  evidence.selection = await page.$eval('[data-testid="isolated-preview-selection"]', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const nativePath = join(project, ".studio/project.json");
  const revisionBefore = JSON.parse(await readFile(nativePath, "utf8")).revision;
  const selectedBox = await page.$eval('[data-testid="isolated-preview-selection"]', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(selectedBox.x, selectedBox.y);
  await page.mouse.down();
  await page.mouse.move(selectedBox.x + 35, selectedBox.y + 20, { steps: 5 });
  await page.mouse.up();
  const moved = await waitFor(async () => {
    const document = JSON.parse(await readFile(nativePath, "utf8"));
    return document.revision > revisionBefore ? document : null;
  }, 10000);
  evidence.durableMove = {
    before: revisionBefore,
    after: moved.revision,
    parameters: moved.sequence.tracks[0].clips[0].staticParameters,
  };
  await page.keyboard.down("Meta");
  await page.keyboard.press("z");
  await page.keyboard.up("Meta");
  const undone = await waitFor(async () => {
    const document = JSON.parse(await readFile(nativePath, "utf8"));
    const x = document.sequence.tracks[0].clips[0].staticParameters?.["transform.position.x"] ?? 0;
    return Math.abs(x) < 0.001 ? document : null;
  }, 10000);
  await page.keyboard.down("Meta");
  await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
  const redone = await waitFor(async () => {
    const document = JSON.parse(await readFile(nativePath, "utf8"));
    const x = document.sequence.tracks[0].clips[0].staticParameters?.["transform.position.x"] ?? 0;
    return x > 30 ? document : null;
  }, 10000);
  evidence.undoRedo = { undoRevision: undone.revision, redoRevision: redone.revision };
  await page.screenshot({ path: join(root, "editor-before-reopen.png") });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  const reopenedPreview = await waitFor(() => page.frames().find(frame =>
    frame.url().includes("/api/projects/MpVFX/preview")));
  const reopenedClip = await waitFor(async () => {
    const element = await reopenedPreview.$("#attack-clip");
    return element && await element.boundingBox() ? element : null;
  }, 10000);
  const reopenedBox = await reopenedClip.boundingBox();
  if (!reopenedBox) throw new Error("Reopened clip has no visible bounds");
  evidence.reopenedPosition = JSON.parse(await readFile(nativePath, "utf8")).sequence.tracks[0].clips[0].staticParameters;
  evidence.reopenedClip = { x: reopenedBox.x, y: reopenedBox.y, width: reopenedBox.width, height: reopenedBox.height };
  await waitFor(() => page.evaluate(() => document.querySelector("hyperframes-player")?.ready), 10000);
  await page.evaluate(() => document.querySelector("hyperframes-player").seek(2));
  await new Promise(done => setTimeout(done, 150));
  const reopenedSeekBox = await reopenedClip.boundingBox();
  if (!reopenedSeekBox) throw new Error("Native clip disappeared after seek");
  evidence.reopenedSeekClip = { x: reopenedSeekBox.x, y: reopenedSeekBox.y };
  evidence.reopenedSeekOpacity = await reopenedPreview.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.getElementById("attack-clip")).opacity));
  evidence.nativeFrameState = await reopenedPreview.evaluate(() => ({
    installed: !!window.__studioNativePlayer,
    binding: document.getElementById("attack-clip")?.getAttribute("data-studio-clip-id"),
    transform: document.getElementById("attack-clip")?.style.transform,
  }));
  evidence.editorStatusText = await page.evaluate(() => document.body.innerText.slice(-1500));
  await page.screenshot({ path: join(root, "editor-after-reopen.png") });
  if (reopenedBox.x < clipBox.x + 25 || reopenedBox.y < clipBox.y + 12) {
    throw new Error("Native move persisted but did not appear after preview reopen");
  }
  if (Math.abs(reopenedSeekBox.x - reopenedBox.x) > 2) {
    throw new Error("Authored GSAP seek overrode the native-owned x position");
  }
  if (Math.abs(evidence.reopenedSeekOpacity - 0.6) > 0.05) {
    throw new Error("Baked native opacity keyframes did not render at seek frame 60");
  }
  if (attack.bridge !== "SecurityError" || attack.parentDom !== "SecurityError" ||
      nestedAttack.bridge !== "SecurityError" || editorResource !== 403 || nestedEditor !== null) {
    throw new Error("Authored preview reached an editor capability or active editor-origin resource");
  }
  await page.mouse.click(reopenedSeekBox.x + reopenedSeekBox.width / 2, reopenedSeekBox.y + reopenedSeekBox.height / 2);
  await page.waitForSelector('[data-testid="remote-inspector"] textarea[aria-label="Text"]', { timeout: 10000 });
  await page.click('[data-testid="remote-inspector"] textarea[aria-label="Text"]');
  // CDP's synthetic Meta+A is not consistently delivered to Electron text
  // controls on this host. Select the focused field through its DOM API, then
  // type through CDP to exercise the real React input and save path.
  await page.$eval('[data-testid="remote-inspector"] textarea[aria-label="Text"]', element => element.select());
  await page.keyboard.type("Edited preview");
  await page.click('[data-testid="remote-inspector"] input[aria-label="Color"]');
  await page.keyboard.type("#ff0000");
  await page.$eval('[data-testid="remote-inspector"] button', button => button.click());
  evidence.inspector.savedHtml = await waitFor(async () => {
    const html = await readFile(join(project, "index.html"), "utf8");
    return html.includes(">Edited preview</div>") && html.includes("#ff0000") ? true : null;
  }, 10000);
  evidence.inspector.panelAfterSave = await page.$eval('[data-testid="remote-inspector"] textarea[aria-label="Text"]',
    element => element.value);
  if (evidence.inspector.panelAfterSave !== "Edited preview") {
    throw new Error("Inspector selection or edited field was lost after save");
  }
  evidence.inspector.liveText = await reopenedPreview.$eval("#attack-clip", element => element.textContent);
  if (evidence.inspector.liveText !== "Edited preview") {
    throw new Error("Inspector saved source without updating the live preview");
  }
  await page.screenshot({ path: join(root, "editor-inspector-selected-after-save.png") });
  await page.click('[data-testid="remote-inspector"] h2');
  await page.keyboard.down("Meta");
  await page.keyboard.press("z");
  await page.keyboard.up("Meta");
  evidence.inspector.undoRestored = await waitFor(async () => {
    const html = await readFile(join(project, "index.html"), "utf8");
    return html.includes(">Preview fixture</div>") && !html.includes("#ff0000") ? true : null;
  }, 10000);
  await page.keyboard.down("Meta");
  await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
  evidence.inspector.redoRestored = await waitFor(async () => {
    const html = await readFile(join(project, "index.html"), "utf8");
    return html.includes(">Edited preview</div>") && html.includes("#ff0000") ? true : null;
  }, 10000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => { location.hash = "#project/MpVFX"; });
  const inspectorReopened = await waitFor(() => page.frames().find(frame =>
    frame.url().includes("/api/projects/MpVFX/preview")));
  evidence.inspector.reopenedText = await waitFor(async () =>
    inspectorReopened.$eval("#attack-clip", element => element.textContent).catch(() => null));
  if (evidence.inspector.reopenedText !== "Edited preview") {
    throw new Error("Inspector edits did not survive project reopen");
  }
  await page.screenshot({ path: join(root, "editor-inspector-after-reopen.png") });
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  browser?.disconnect();
  child.kill("SIGTERM");
  await writeFile(join(root, "app.log"), log);
}
