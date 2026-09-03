#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const STUDIO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_MEDIA = join(
  STUDIO_DIR,
  "tests/e2e/fixtures/design-panel-qa/assets/test.mp4",
);
const SOURCE_GSAP = join(STUDIO_DIR, "fixtures/vendor/gsap.min.js");
const PROJECT_ID = "native-keyframe-workflow";
const PROJECT_FILE = "index.html";
const NATIVE_PROJECT_FILE = ".studio/project.json";
const CHROMIUM_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function availableExecutable() {
  for (const candidate of CHROMIUM_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported local browser.
    }
  }
  throw new Error("Set CHROME_PATH to a Chromium-compatible browser executable");
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error("Could not allocate a test port"));
        else resolvePort(port);
      });
    });
  });
}

async function waitUntil(predicate, message, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(message);
}

async function waitForHttp(url, serverProcess, serverOutput) {
  await waitUntil(
    async () => {
      if (serverProcess.exitCode !== null) {
        throw new Error(`Studio exited before startup:\n${serverOutput.join("")}`);
      }
      try {
        const response = await fetch(url);
        return response.ok;
      } catch {
        return false;
      }
    },
    `Studio did not become ready at ${url}`,
    20_000,
  );
}

async function selectByDomId(page, id) {
  await page.evaluate((nextId) => {
    void window.__studioTest.selectByDomId(nextId);
  }, id);
  await page.waitForFunction(
    (nextId) => window.__playerStore?.getState().selectedElementId?.endsWith(`#${nextId}`),
    { timeout: 10_000 },
    id,
  );
}

async function requestSeek(page, time) {
  await page.evaluate((nextTime) => window.__playerStore.getState().requestSeek(nextTime), time);
  await page.waitForFunction(
    (nextTime) => Math.abs(window.__playerStore.getState().currentTime - nextTime) < 0.001,
    { timeout: 5_000 },
    time,
  );
}

async function readNativeVideoState(page) {
  return page.evaluate(() => {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      for (const iframe of root.querySelectorAll("iframe")) {
        try {
          const target = iframe.contentDocument?.querySelector("#native-video");
          if (target) {
            const nativePlayer = iframe.contentWindow?.__studioNativePlayer;
            const nativeCandidates = [
              ...(iframe.contentDocument?.querySelectorAll("[data-studio-clip-id]") ?? []),
            ];
            return {
              transform: target.style.transform,
              visibility: target.style.visibility,
              nativeClipId: target.getAttribute("data-studio-clip-id"),
              nativeOwned: target.getAttribute("data-studio-native-owned"),
              paused: target.paused,
              iframeReadyState: iframe.contentDocument?.readyState,
              iframeSource: iframe.getAttribute("src"),
              nativePlayerPresent: Boolean(nativePlayer),
              nativePlayerTime: nativePlayer?.getTime?.(),
              nativePlayerDuration: nativePlayer?.getDuration?.(),
              nativePlayerPlaying: nativePlayer?.isPlaying?.(),
              nativeCandidateCount: nativeCandidates.length,
              targetUsesLiveDocument: target.ownerDocument === iframe.contentDocument,
              targetIsLiveHTMLElement: target instanceof iframe.contentWindow.HTMLElement,
              candidateIds: nativeCandidates.map((candidate) =>
                candidate.getAttribute("data-studio-clip-id"),
              ),
            };
          }
        } catch {
          // Cross-origin frames are not the local project preview.
        }
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    return null;
  });
}

function projectSource() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #111; }
      [data-composition-id] { position: relative; overflow: hidden; }
      #native-video { position: absolute; left: 640px; top: 360px; width: 640px; height: 360px; }
    </style>
    <script src="vendor/gsap.min.js"></script>
  </head>
  <body>
    <main
      id="root"
      data-composition-id="${PROJECT_ID}"
      data-composition-file="index.html"
      data-duration="4"
      data-width="1920"
      data-height="1080"
    >
      <video
        id="native-video"
        class="clip"
        data-hf-id="native-video"
        data-start="0"
        data-duration="4"
        data-track-index="0"
        src="assets/test.mp4"
      ></video>
    </main>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["${PROJECT_ID}"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>`;
}

function nativeProject() {
  return {
    schemaVersion: 1,
    id: `project:${PROJECT_ID}`,
    revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#111111" },
    assets: [
      { id: "asset:native-video", kind: "video", name: "test.mp4", durationFrames: 120 },
    ],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [
        {
          id: "track:video:0",
          kind: "video",
          lane: { authoredTrack: 0, displayTrack: 0 },
          clips: [
            {
              id: "clip:native-video",
              assetId: "asset:native-video",
              binding: {
                sourceFile: PROJECT_FILE,
                domId: "native-video",
                hfId: "native-video",
                selector: "#native-video",
                selectorIndex: 0,
              },
              startFrame: 0,
              durationFrames: 120,
              sourceInFrame: 0,
              playbackRate: { numerator: 1, denominator: 1 },
              muted: false,
              staticParameters: {},
              effects: [],
              parameterTracks: [
                {
                  schemaVersion: 1,
                  id: "parameter:rotation",
                  parameterId: "transform.rotation",
                  valueType: "number",
                  frameRate: { numerator: 30, denominator: 1 },
                  keyframes: [
                    {
                      id: "rotation:frame:0",
                      frame: 0,
                      value: 0,
                      outgoing: { type: "linear" },
                    },
                    {
                      id: "rotation:frame:60",
                      frame: 60,
                      value: -180,
                      outgoing: { type: "hold" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

async function main() {
  const scratchRoot = await mkdtemp(join(tmpdir(), "studio-native-keyframe-workflow-"));
  const projectDir = join(scratchRoot, PROJECT_ID);
  const sourcePath = join(projectDir, PROJECT_FILE);
  const nativePath = join(projectDir, NATIVE_PROJECT_FILE);
  let browser;
  let serverProcess;
  const serverOutput = [];

  try {
    await mkdir(join(projectDir, "assets"), { recursive: true });
    await mkdir(join(projectDir, "vendor"), { recursive: true });
    await mkdir(join(projectDir, ".studio"), { recursive: true });
    await cp(SOURCE_MEDIA, join(projectDir, "assets/test.mp4"));
    await cp(SOURCE_GSAP, join(projectDir, "vendor/gsap.min.js"));
    await writeFile(sourcePath, projectSource());
    const initialNative = nativeProject();
    await writeFile(nativePath, `${JSON.stringify(initialNative, null, 2)}\n`);

    const port = await freePort();
    const studioUrl = `http://127.0.0.1:${port}`;
    serverProcess = spawn(
      "npm",
      ["run", "dev", "--", "--port", String(port), "--strictPort"],
      {
        cwd: STUDIO_DIR,
        env: { ...process.env, MPVFX_PROJECTS_DIR: scratchRoot },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    serverProcess.stdout.on("data", (chunk) => serverOutput.push(chunk.toString()));
    serverProcess.stderr.on("data", (chunk) => serverOutput.push(chunk.toString()));
    await waitForHttp(studioUrl, serverProcess, serverOutput);
    const sidecarResponse = await fetch(
      `${studioUrl}/api/projects/${PROJECT_ID}/files/${encodeURIComponent(NATIVE_PROJECT_FILE)}?optional=1`,
    );
    const sidecarBody = await sidecarResponse.text();
    const servedSidecar = sidecarResponse.ok
      ? JSON.parse(JSON.parse(sidecarBody).content)
      : null;
    assert(
      sidecarResponse.ok && servedSidecar?.id === "project:native-keyframe-workflow",
      `Studio could not serve the seeded native sidecar (${sidecarResponse.status}): ${sidecarBody}`,
    );

    browser = await puppeteer.launch({
      executablePath: await availableExecutable(),
      headless: true,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    const pageErrors = [];
    const failedResponses = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 500) failedResponses.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(`${studioUrl}/#project/${PROJECT_ID}`, {
      waitUntil: "networkidle0",
      timeout: 30_000,
    });
    await page.waitForFunction(
      () =>
        typeof window.__studioTest?.selectByDomId === "function" &&
        typeof window.__playerStore?.getState === "function",
      { timeout: 20_000 },
    );

    await selectByDomId(page, "native-video");
    try {
      await page.waitForFunction(
        () => {
          const roots = [document];
          for (let index = 0; index < roots.length; index += 1) {
            const root = roots[index];
            for (const iframe of root.querySelectorAll("iframe")) {
              try {
                if (
                  iframe.contentDocument
                    ?.querySelector("#native-video")
                    ?.getAttribute("data-studio-clip-id") === "clip:native-video"
                ) return true;
              } catch {
                // Ignore unrelated cross-origin frames.
              }
            }
            for (const element of root.querySelectorAll("*")) {
              if (element.shadowRoot) roots.push(element.shadowRoot);
            }
          }
          return false;
        },
        { timeout: 15_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(async () => {
        const response = await fetch(
          `/api/projects/${encodeURIComponent("native-keyframe-workflow")}/files/${encodeURIComponent(".studio/project.json")}?optional=1`,
        );
        return {
          sidecarStatus: response.status,
          sidecar: await response.text(),
          bodyText: document.body.innerText,
          preview: await (async () => {
            const roots = [document];
            for (let index = 0; index < roots.length; index += 1) {
              const root = roots[index];
              for (const iframe of root.querySelectorAll("iframe")) {
                try {
                  const video = iframe.contentDocument?.querySelector("#native-video");
                  if (video) {
                    return {
                      nativeClipId: video.getAttribute("data-studio-clip-id"),
                      nativeOwned: video.getAttribute("data-studio-native-owned"),
                    };
                  }
                } catch {
                  // Ignore unrelated frames.
                }
              }
              for (const element of root.querySelectorAll("*")) {
                if (element.shadowRoot) roots.push(element.shadowRoot);
              }
            }
            return null;
          })(),
        };
      });
      throw new Error(
        `Native runtime did not bind the persisted media clip: ${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }
    const selectedKey = await page.evaluate(
      () => window.__playerStore.getState().selectedElementId,
    );
    assert(selectedKey, "Native media selection did not expose a timeline identity");
    const expanded = await page.evaluate(
      (key) => window.__playerStore.getState().expandedClipIds.has(key),
      selectedKey,
    );
    if (!expanded) {
      const reveal = await page.$('button[aria-label^="Show "][aria-label$=" lanes"]');
      if (!reveal) {
        const diagnostics = await page.evaluate(() => {
          const state = window.__playerStore.getState();
          return {
            selectedElementId: state.selectedElementId,
            elements: state.elements.map((element) => ({
              id: element.id,
              key: element.key,
              domId: element.domId,
              hfId: element.hfId,
              sourceFile: element.sourceFile,
              selector: element.selector,
              selectorIndex: element.selectorIndex,
            })),
            expandedClipIds: [...state.expandedClipIds],
            buttons: [...document.querySelectorAll("button")]
              .map((button) => button.getAttribute("aria-label"))
              .filter(Boolean),
          };
        });
        throw new Error(
          `Native keyframed clip did not expose a lane disclosure control: ${JSON.stringify(diagnostics)}`,
        );
      }
      await reveal.click();
    }
    await page.waitForSelector('[data-timeline-property-lane][data-property-group="rotation"]', {
      timeout: 15_000,
    });
    await page.waitForSelector('button[aria-label="rotation keyframe at 0s"]', {
      timeout: 15_000,
    });
    await page.waitForSelector('button[aria-label="rotation keyframe at 2s"]', {
      timeout: 15_000,
    });

    // Frame 30 lies exactly halfway between frame 0 and frame 60 at 30 fps.
    await requestSeek(page, 1);
    const midpoint = await readNativeVideoState(page);
    assert(midpoint?.nativeClipId === "clip:native-video", "Native sidecar did not bind the media clip");
    assert(
      midpoint.nativeOwned?.split(/\s+/).includes("transform.rotation"),
      `Native runtime did not claim the rotation channel: ${JSON.stringify(midpoint)}`,
    );
    assert(
      midpoint.transform.includes("rotate(-90deg)"),
      `Frame-30 midpoint was not exact linear -90deg: ${midpoint.transform}`,
    );

    // Pause/play and repeated exact seeks must reproduce identical frame state.
    await page.evaluate(() => window.__playerStore.getState().requestPlayback(true));
    await page.waitForFunction(() => window.__playerStore.getState().isPlaying, { timeout: 5_000 });
    await page.evaluate(() => window.__playerStore.getState().requestPlayback(false));
    await page.waitForFunction(() => !window.__playerStore.getState().isPlaying, { timeout: 5_000 });
    await requestSeek(page, 1);
    const afterPause = await readNativeVideoState(page);
    assert(
      afterPause?.transform === midpoint.transform,
      `Native pause/reseek changed frame state: ${midpoint.transform} -> ${afterPause?.transform}`,
    );

    // The connector belongs to the source keyframe's outgoing segment. Editing
    // it through Studio must persist only the native sidecar, bump one revision,
    // and immediately make the midpoint hold the source value.
    const sourceBefore = await readFile(sourcePath, "utf8");
    const connector = await page.$('button[data-keyframe-ease-button]');
    assert(connector, "Native rotation lane did not expose its outgoing interpolation control");
    await connector.click();
    await page.waitForSelector('[data-native-interpolation-editor]', { timeout: 10_000 });
    const holdButton = await page.$(
      '[data-native-interpolation-editor] [role="group"][aria-label="Interpolation"] button:nth-of-type(1)',
    );
    assert(holdButton, "Native interpolation editor did not expose Hold");
    await holdButton.click();

    await waitUntil(
      async () => {
        const saved = JSON.parse(await readFile(nativePath, "utf8"));
        return (
          saved.revision === 1 &&
          saved.sequence.tracks[0].clips[0].parameterTracks[0].keyframes[0].outgoing.type ===
            "hold"
        );
      },
      "Native outgoing interpolation edit never reached durable project state",
    );
    assert(
      (await readFile(sourcePath, "utf8")) === sourceBefore,
      "Native interpolation edit unexpectedly rewrote compatibility HTML",
    );
    await requestSeek(page, 1);
    await waitUntil(
      async () => (await readNativeVideoState(page))?.transform.includes("rotate(0deg)"),
      "Committed Hold interpolation did not refresh the native preview",
    );

    const saved = JSON.parse(await readFile(nativePath, "utf8"));
    assert(saved.revision === 1, `Expected one durable native revision, found ${saved.revision}`);
    assert(pageErrors.length === 0, `Browser page errors:\n${pageErrors.join("\n")}`);
    assert(failedResponses.length === 0, `Server failures:\n${failedResponses.join("\n")}`);
    console.log("PASS native keyframes: visible non-GSAP lanes and exact frame-30 interpolation");
    console.log("PASS native keyframes: deterministic pause/reseek on the bound media clip");
    console.log("PASS native keyframes: source/outgoing UI edit persisted one sidecar revision");
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveExit) => serverProcess.once("exit", resolveExit)),
        new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
      ]);
      if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
    }
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
