import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";
const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), "mpvfx-library-packaged-"));
const evidenceDir = process.env.MPVFX_UI_EVIDENCE_DIR ? resolve(process.env.MPVFX_UI_EVIDENCE_DIR) : root;
await mkdir(evidenceDir, { recursive: true });
const lib = join(root, "Test Film.mpvfxlibrary"),
  video = join(root, "Shared Khé¿.mp4");
execFileSync(require("ffmpeg-static"), [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=red:size=320x180:rate=24:duration=2",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=48000:duration=1",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-shortest",
  video,
]);
if (process.env.MPVFX_SILENT_FIXTURE === "1") {
  const silent = join(root, "silent.mp4");
  execFileSync(require("ffmpeg-static"), ["-v", "error", "-i", video, "-an", "-c:v", "copy", silent]);
  await writeFile(video, await readFile(silent));
}
const output = join(root, "Film export.mp4");
let child,
  browser,
  inspector,
  page,
  log = "";
async function launch() {
  child = spawn(
    resolve("out/MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX"),
    [
      "--inspect=0",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(root, "chromium")}`,
    ],
    {
      env: {
        ...process.env,
        MPVFX_USER_DATA_DIR: join(root, "data"),
        ELECTRON_RUN_AS_NODE: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  log = "";
  child.stderr.on("data", (v) => {
    log += v;
  });
  child.stdout.on("data", (v) => {
    log += v;
  });
  const endpoints = await new Promise((res, rej) => {
    const timer = setInterval(() => {
      const main = log.match(/Debugger listening on (ws:\/\/\S+)/),
        chrome = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (main && chrome) {
        clearInterval(timer);
        res({ main: main[1], chrome: chrome[1] });
      } else if (child.exitCode !== null) {
        clearInterval(timer);
        rej(new Error(log));
      }
    }, 50);
    setTimeout(() => {
      clearInterval(timer);
      rej(new Error("Startup timeout " + log.slice(-2000)));
    }, 30000).unref();
  });
  inspector = new WebSocket(endpoints.main);
  await new Promise((res, rej) => {
    inspector.addEventListener("open", res, { once: true });
    inspector.addEventListener("error", rej, { once: true });
  });
  browser = await puppeteer.connect({ browserWSEndpoint: endpoints.chrome });
  page = await browser
    .waitForTarget((t) => t.url().startsWith("mpvfx://editor/"), {
      timeout: 30000,
    })
    .then((t) => t.page());
  page.on("pageerror", (e) => console.log("renderer-error", e.message));
  await page.setViewport({ width: 1600, height: 1000 });
  await page.waitForSelector('[aria-label="Library browser"]', {
    timeout: 30000,
  });
}
let seq = 0;
async function mainEval(expression) {
  const id = ++seq;
  return new Promise((res, rej) => {
    const handle = (e) => {
      const data = JSON.parse(e.data);
      if (data.id !== id) return;
      inspector.removeEventListener("message", handle);
      if (data.error || data.result?.exceptionDetails)
        rej(new Error(JSON.stringify(data)));
      else res(data.result?.result?.value);
    };
    inspector.addEventListener("message", handle);
    inspector.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
}
async function dialogs() {
  await mainEval(
    `(()=>{const e=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron');globalThis.libraryDialogs={saves:[],opens:[]};e.dialog.showSaveDialog=async()=>globalThis.libraryDialogs.saves.shift()??{canceled:true};e.dialog.showOpenDialog=async()=>globalThis.libraryDialogs.opens.shift()??{canceled:true,filePaths:[]};return true;})()`,
  );
}
async function queueSave(path) {
  await mainEval(
    `globalThis.libraryDialogs.saves.push({canceled:false,filePath:${JSON.stringify(path)}})`,
  );
}
async function queueOpen(paths) {
  await mainEval(
    `globalThis.libraryDialogs.opens.push({canceled:false,filePaths:${JSON.stringify(paths)}})`,
  );
}
async function click(text) {
  await page.waitForFunction(
    (t) =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent.trim() === t && !b.disabled,
      ),
    {},
    text,
  );
  await page.evaluate(
    (t) =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent.trim() === t && !b.disabled)
        .click(),
    text,
  );
}
async function views() {
  return (await page.evaluate(() => window.mpvfx.library({ type: "list" })))
    .libraries;
}
async function until(fn, message, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    message +
      "\n" +
      (await page.evaluate(() => document.body.innerText.slice(-2000))),
  );
}
async function openMedia() {
  await page.evaluate(() => {
    const d = [...document.querySelectorAll("details")].find((d) =>
      d.querySelector("summary")?.textContent.startsWith("Library media"),
    );
    if (d) d.open = true;
  });
}
async function verifyInterface() {
  const layout = await page.evaluate(() => {
    const library = document.querySelector('[aria-label="Library browser"]');
    const preview = document.querySelector('[aria-label="Composition preview"]');
    const timeline = document.querySelector('[aria-label="Timeline"]');
    const playback = document.querySelector('[aria-label="Playback time"]');
    const play = document.querySelector('button[aria-label="Play"]');
    if (!library || !preview || !timeline || !playback || !play)
      throw new Error("v0.0.7 library, preview, timeline, or playback control is missing");
    const top = preview.getBoundingClientRect();
    const bottom = timeline.getBoundingClientRect();
    return {
      previewTop: top.top,
      previewBottom: top.bottom,
      timelineTop: bottom.top,
      timelineBottom: bottom.bottom,
      viewportBottom: window.innerHeight,
      bodyOverflow: document.body.scrollHeight - window.innerHeight,
    };
  });
  if (!(layout.previewTop < layout.previewBottom && layout.previewBottom <= layout.timelineTop + 2 &&
      layout.timelineBottom <= layout.viewportBottom + 2 &&
      layout.viewportBottom - layout.timelineBottom <= 16 && layout.bodyOverflow <= 2))
    throw new Error(`v0.0.7 editor layout changed: ${JSON.stringify(layout)}`);
  await page.click('[data-clip="true"]');
  const border = await page.waitForSelector('[data-dom-edit-selection-box="true"]', { timeout: 20000 });
  const borderVisible = await border.evaluate(node => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      (parseFloat(style.borderTopWidth) > 0 || parseFloat(style.outlineWidth) > 0);
  });
  if (!borderVisible) throw new Error("Selected clip has no visible preview selection border");
  const removeSilence = await page.$('button[aria-label="Remove silence"]');
  if (!removeSilence || await removeSilence.evaluate(node => node.disabled))
    throw new Error("Selected video lost its Remove silence action");
  await page.screenshot({ path: join(evidenceDir, "v007-selected-editor.png") });
  await page.click('button[aria-label="Play"]');
  await page.waitForSelector('button[aria-label="Pause"]', { timeout: 5000 });
  await page.click('button[aria-label="Pause"]');
  await page.click('button[aria-label="Shortcuts and tools"]');
  await page.waitForFunction(() => !!document.querySelector('button[data-history-action="undo"]:not(:disabled)'), { timeout: 10000 });
  const undo = await page.$('button[data-history-action="undo"]');
  if (!undo) throw new Error("Undo is unavailable after adding a clip");
  await undo.click();
  await until(async () => (await page.$$('[data-clip="true"]')).length === 0, "Undo did not remove the added clip");
  await page.waitForFunction(() => !!document.querySelector('button[data-history-action="redo"]:not(:disabled)'), { timeout: 10000 });
  await page.click('button[data-history-action="redo"]');
  await page.waitForSelector('[data-clip="true"]', { timeout: 20000 });
  await writeFile(join(evidenceDir, "v007-ui-layout.json"), JSON.stringify(layout, null, 2));
}
async function close() {
  inspector?.close();
  await browser?.disconnect();
  if (child?.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("App did not close")), 20000),
      ),
    ]);
  }
}
try {
  await launch();
  await dialogs();
  await queueSave(lib);
  await click("New library");
  const library = await until(async () => {
    const l = (await views())[0];
    return l?.projects.length === 1 ? l : null;
  }, "Library creation failed");
  const first = library.projects[0].id;
  await page.waitForFunction(
    (id) => document.querySelector('[aria-label="Project"]')?.value === id,
    {},
    first,
  );
  await openMedia();
  await queueOpen([video]);
  await click("Import into event…");
  await until(
    async () => (await views())[0].assets.length === 1,
    "Managed import failed",
  );
  await click("Add to timeline");
  await page.waitForSelector('[data-clip="true"]', { timeout: 20000 });
  const docPath = (id) => join(lib, "Projects", id, ".studio/project.json");
  const document1 = await until(async () => {
    const d = JSON.parse(await readFile(docPath(first), "utf8"));
    return d.sequence.tracks.some((t) => t.clips.length) ? d : null;
  }, "First project edit did not persist");
  await verifyInterface();
  const firstHtml = await readFile(join(lib, "Projects", first, "index.html"), "utf8");
  const expectedAudio = process.env.MPVFX_SILENT_FIXTURE === "1" ? "false" : "true";
  if (!firstHtml.includes(`data-has-audio="${expectedAudio}"`)) {
    throw new Error(`Imported video did not persist its actual audio capability (${expectedAudio})`);
  }
  await click("New project");
  await page.type('[aria-label="Project name"]', "Short Version");
  await click("Create");
  const second = await until(async () => {
    const l = (await views())[0];
    return l.projects.find((p) => p.name === "Short Version")?.id;
  }, "Second project missing");
  await page.waitForFunction(
    (id) => document.querySelector('[aria-label="Project"]')?.value === id,
    {},
    second,
  );
  await until(
    async () => (await page.$$('[data-clip="true"]')).length === 0,
    "Old timeline leaked into new project",
  );
  await openMedia();
  await click("Add to timeline");
  await page.waitForSelector('[data-clip="true"]', { timeout: 20000 });
  const document2 = await until(async () => {
    const d = JSON.parse(await readFile(docPath(second), "utf8"));
    return d.sequence.tracks.some((t) => t.clips.length) ? d : null;
  }, "Second project edit did not persist");
  if ((await views())[0].assets.length !== 1)
    throw new Error("Shared asset duplicated");
  const source1 = document1.assets.find((a) => a.kind === "video").source,
    source2 = document2.assets.find((a) => a.kind === "video").source;
  if (source1 !== source2)
    throw new Error("Projects did not reference the same catalog asset");
  const exported = await page.evaluate(async (id) => {
    const r = await window.mpvfx.request({
      id: crypto.randomUUID(),
      path: `/api/projects/${id}/render`,
      method: "POST",
      headers: [["content-type", "application/json"]],
      body: new TextEncoder().encode(
        JSON.stringify({
          format: "mp4",
          fps: 24,
          quality: "draft",
          dimensions: { width: 320, height: 180 },
        }),
      ).buffer,
    });
    return {
      status: r.status,
      body: JSON.parse(new TextDecoder().decode(r.body)),
    };
  }, second);
  if (exported.status !== 200 || !exported.body.persistent)
    throw new Error(JSON.stringify(exported));
  await page.select('[aria-label="Project"]', first);
  await page.waitForFunction(
    (id) => document.querySelector('[aria-label="Project"]')?.value === id,
    {},
    first,
  );
  const job = await until(
    async () => {
      const j = (await views())[0].jobs[0];
      if (j?.status === "failed") throw new Error(j.error);
      return j?.status === "complete" ? j : null;
    },
    "Packaged export did not complete",
    90000,
  );
  await queueSave(output);
  await page.evaluate(
    async ({ libraryId, jobId }) =>
      window.mpvfx.library({ type: "saveOutput", libraryId, jobId }),
    { libraryId: library.id, jobId: job.id },
  );
  if ((await stat(output)).size < 100) throw new Error("Output missing");
  await page.screenshot({ path: join(evidenceDir, "library-workflow.png") });
  await close();
  await launch();
  await page.waitForSelector('[data-clip="true"]', { timeout: 20000 });
  const reopened = (await views())[0];
  if (
    reopened.projects.length !== 2 ||
    reopened.assets.length !== 1 ||
    reopened.jobs[0].status !== "complete"
  )
    throw new Error("Reopen lost library state");
  const result = {
    packagedApp: execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", resolve("out/MpVFX-darwin-arm64/MpVFX.app/Contents/Info.plist")], { encoding: "utf8" }).trim(),
    profile: root,
    library: lib,
    projects: reopened.projects.map((p) => p.name),
    sharedMedia: reopened.assets.length,
    firstProjectReopened: true,
    exportSurvivedProjectSwitch: true,
    output,
    outputBytes: (await stat(output)).size,
  };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error);
  console.error(log.slice(-3500));
  if (page)
    await page.screenshot({ path: join(root, "failure.png") }).catch(() => {});
  console.error("Evidence:", root);
  process.exitCode = 1;
} finally {
  await close().catch((e) => console.error(e));
}
