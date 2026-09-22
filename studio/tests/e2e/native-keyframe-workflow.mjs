#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
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
import { verifyProfessionalTimeline } from "./professional-timeline-scenarios.mjs";
import { minimalEnvironment } from "../../../scripts/automation/privacy.mjs";

const STUDIO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const SOURCE_GSAP = require.resolve("gsap/dist/gsap.min.js");
const ELECTRON_MODE = process.argv.includes("--electron");
const VIEWPORT = process.argv
  .find((arg) => arg.startsWith("--viewport="))
  ?.match(/^--viewport=(\d+)x(\d+)$/)
  ?.slice(1)
  .map(Number);
const OUTPUT_DIR = join(
  STUDIO_DIR,
  "out/native-keyframe-verification",
  ELECTRON_MODE ? `${process.platform}-${process.arch}-electron` : "browser",
);
const DELAY_KEYFRAME_RESPONSE_MS = Number(
  process.argv
    .find((arg) => arg.startsWith("--delay-keyframe-response="))
    ?.split("=")[1] ?? 0,
);
const PROJECT_ID = "native-keyframe-workflow";
const AB_PROJECT_ID = `${PROJECT_ID}-ab`;
const PROJECT_FILE = "index.html";
const NATIVE_PROJECT_FILE = ".studio/project.json";
const CHROMIUM_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  require("puppeteer").executablePath(),
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
  throw new Error(
    "Set CHROME_PATH to a Chromium-compatible browser executable",
  );
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
        else if (port === null)
          reject(new Error("Could not allocate a test port"));
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

async function readPersistedJson(path, timeoutMs = 5_000) {
  const started = Date.now();
  while (true) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      // Undo/Redo uses the legacy file endpoint. A direct disk read can overlap
      // its write; retry only incomplete JSON/missing files, never assertions.
      if (
        (!(error instanceof SyntaxError) && error?.code !== "ENOENT") ||
        Date.now() - started >= timeoutMs
      ) {
        throw new Error(`Could not read persisted JSON from ${path}`, {
          cause: error,
        });
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
}

async function waitForHttp(url, serverProcess, serverOutput) {
  await waitUntil(
    async () => {
      if (serverProcess.exitCode !== null) {
        throw new Error(
          `Studio exited before startup:\n${serverOutput.join("")}`,
        );
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

async function selectByDomId(page, id, requireVisibleBox = true) {
  await waitUntil(async () => {
    const preview = await readNativeVideoState(page);
    return (
      preview?.nativeClipId === "clip:native-video" &&
      preview.nativePlayerPresent &&
      preview.iframeReadyState === "complete"
    );
  }, "Native preview was not ready for selection");
  if (
    await page.evaluate(
      () => typeof window.__studioTest?.selectByDomId === "function",
    )
  ) {
    await page.evaluate(
      (nextId) => window.__studioTest.selectByDomId(nextId),
      id,
    );
  } else {
    // Production intentionally has no test hooks. Select the actual timeline
    // clip, which activates the same canvas selection and property inspector.
    const clip = await page.waitForSelector(
      `pierce/[data-clip="true"][data-el-id$="#${id}"]`,
    );
    await clip.click();
  }
  if (requireVisibleBox) {
    await page.waitForSelector('pierce/[data-dom-edit-selection-box="true"]', {
      timeout: 10_000,
    });
  }
}

async function readWorkflowUiState(page) {
  return page.evaluate(() => {
    const roots = [document];
    let playbackTime = null,
      toolbar = null;
    const keys = [];
    for (let index = 0; index < roots.length; index += 1) {
      for (const element of roots[index].querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
        const label = element.getAttribute("aria-label");
        if (label === "Playback time") playbackTime = element.textContent;
        if (
          label === "Add keyframe at playhead" ||
          label === "Remove keyframe at playhead"
        )
          toolbar = label;
        if (element.hasAttribute("data-keyframe-percentage"))
          keys.push({
            label,
            percentage: element.getAttribute("data-keyframe-percentage"),
            pressed: element.getAttribute("aria-pressed"),
            selected: element.getAttribute("data-keyframe-selected"),
            group: element.getAttribute("data-keyframe-group"),
          });
      }
    }
    return { playbackTime, toolbar, keys };
  });
}

async function traceWorkflow(page, phase) {
  const preview = await readNativeVideoState(page);
  const ui = await readWorkflowUiState(page);
  const record = {
    phase,
    time: preview?.nativePlayerTime,
    transform: preview?.transform,
    ...ui,
  };
  console.log(`KEYFRAME_PHASE ${JSON.stringify(record)}`);
}

async function requestSeek(page, time) {
  await traceWorkflow(page, `seek-${time}-before`);
  if (
    await page.evaluate(
      () => typeof window.__playerStore?.getState === "function",
    )
  ) {
    await page.evaluate(
      (nextTime) => window.__playerStore.getState().requestSeek(nextTime),
      time,
    );
  } else {
    const clip = await page.waitForSelector(
      'pierce/[data-clip="true"][data-el-id$="#native-video"]',
    );
    const ruler = await page.waitForSelector(
      'pierce/[data-timeline-grid-cell="major"]',
    );
    const clipRect = await clip.boundingBox();
    const rulerRect = await ruler.boundingBox();
    assert(clipRect && rulerRect, "Timeline did not expose seek geometry");
    // This generated fixture starts at 0 and lasts exactly 4 seconds. A quarter
    // frame avoids floating point rounding below the requested frame boundary.
    await page.mouse.click(
      clipRect.x + (clipRect.width * (time + 1 / 120)) / 4,
      rulerRect.y + 4,
    );
  }
  await waitUntil(async () => {
    const state = await readNativeVideoState(page);
    return (
      Math.floor((state?.nativePlayerTime ?? -1) * 30 + 1e-6) ===
      Math.round(time * 30)
    );
  }, `Native player did not seek to ${time}s`);
  await traceWorkflow(page, `seek-${time}-observed`);
}

async function captureUi(page, label) {
  if (label !== "failure") {
    await page.waitForFunction(
      () => {
        const roots = [document];
        for (let index = 0; index < roots.length; index += 1) {
          for (const element of roots[index].querySelectorAll("*")) {
            if (element.shadowRoot) roots.push(element.shadowRoot);
            if (
              ["Preparing preview assets", "Loading composition"].includes(
                element.textContent?.trim(),
              ) &&
              element.getBoundingClientRect().height > 0
            )
              return false;
          }
        }
        return true;
      },
      { timeout: 15_000 },
    );
  }
  await mkdir(OUTPUT_DIR, { recursive: true });
  await page.screenshot({ path: join(OUTPUT_DIR, `${label}.png`) });
  const hierarchy = await page.evaluate(() => {
    const roots = [document];
    const controls = [];
    for (let index = 0; index < roots.length; index += 1) {
      for (const element of roots[index].querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (!element.matches("button,input,select,[role],[aria-label]"))
          continue;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        controls.push({
          tag: element.tagName,
          label: element.getAttribute("aria-label"),
          text: element.innerText?.slice(0, 100),
          value: element.value,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
      }
    }
    return controls;
  });
  await writeFile(
    join(OUTPUT_DIR, `${label}-ui.json`),
    JSON.stringify(hierarchy, null, 2),
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
              ...(iframe.contentDocument?.querySelectorAll(
                "[data-studio-clip-id]",
              ) ?? []),
            ];
            return {
              transform: target.style.transform,
              width: Number.parseFloat(
                iframe.contentWindow.getComputedStyle(target).width,
              ),
              height: Number.parseFloat(
                iframe.contentWindow.getComputedStyle(target).height,
              ),
              opacity: Number.parseFloat(
                iframe.contentWindow.getComputedStyle(target).opacity,
              ),
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
              targetUsesLiveDocument:
                target.ownerDocument === iframe.contentDocument,
              targetIsLiveHTMLElement:
                target instanceof iframe.contentWindow.HTMLElement,
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

function projectSource(projectId = PROJECT_ID) {
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
      data-composition-id="${projectId}"
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
      window.__timelines["${projectId}"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>`;
}

function nativeProject(projectId = PROJECT_ID) {
  return {
    schemaVersion: 1,
    id: `project:${projectId}`,
    revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#111111" },
    assets: [
      {
        id: "asset:native-video",
        kind: "video",
        name: "test.mp4",
        durationFrames: 120,
      },
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
  const scratchRoot = await mkdtemp(
    join(tmpdir(), "studio-native-keyframe-workflow-"),
  );
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  const projectsRoot = ELECTRON_MODE
    ? join(scratchRoot, "projects")
    : scratchRoot;
  const projectDir = join(projectsRoot, PROJECT_ID);
  const sourcePath = join(projectDir, PROJECT_FILE);
  let nativePath = join(projectDir, NATIVE_PROJECT_FILE);
  let browser;
  let serverProcess;
  let page;
  const serverOutput = [];

  try {
    await mkdir(join(projectDir, "assets"), { recursive: true });
    await mkdir(join(projectDir, "vendor"), { recursive: true });
    await mkdir(join(projectDir, ".studio"), { recursive: true });
    await promisify(execFile)(require("ffmpeg-static"), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=640x360:r=30:d=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      join(projectDir, "assets/test.mp4"),
    ]);
    await cp(SOURCE_GSAP, join(projectDir, "vendor/gsap.min.js"));
    await writeFile(sourcePath, projectSource());
    const initialNative = nativeProject();
    await writeFile(nativePath, `${JSON.stringify(initialNative, null, 2)}\n`);

    let studioUrl;
    if (ELECTRON_MODE) {
      // The unique profile isolates the application lock, projects, settings,
      // cache, crash recorder and native window from the user's running editor.
      const environment = minimalEnvironment();
      environment.MPVFX_USER_DATA_DIR = scratchRoot;
      serverProcess = spawn(
        require("electron"),
        [
          "--remote-debugging-port=0",
          ...(process.platform === "linux" ? ["--no-sandbox"] : []),
          STUDIO_DIR,
        ],
        {
          cwd: STUDIO_DIR,
          env: environment,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      serverProcess.stdout.on("data", (chunk) =>
        serverOutput.push(chunk.toString()),
      );
      serverProcess.stderr.on("data", (chunk) =>
        serverOutput.push(chunk.toString()),
      );
      let endpoint;
      await waitUntil(
        async () => {
          if (serverProcess.exitCode !== null)
            throw new Error(
              `Electron exited before startup: ${serverOutput.join("")}`,
            );
          endpoint = serverOutput
            .join("")
            .match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
          return Boolean(endpoint);
        },
        "Electron did not publish a debugging endpoint",
        30_000,
      );
      browser = await puppeteer.connect({
        browserWSEndpoint: endpoint,
        defaultViewport: null,
        protocolTimeout: 30_000,
      });
      await waitUntil(
        async () => {
          page = (await browser.pages()).find((candidate) =>
            /^http:\/\/127\.0\.0\.1:\d+/.test(candidate.url()),
          );
          return Boolean(page);
        },
        "Electron did not open its native editor window",
        30_000,
      );
      if (VIEWPORT)
        await page.setViewport({ width: VIEWPORT[0], height: VIEWPORT[1] });
      studioUrl = new URL(page.url()).origin;
    } else {
      const port = await freePort();
      studioUrl = `http://127.0.0.1:${port}`;
      serverProcess = spawn(
        process.execPath,
        [
          join(dirname(require.resolve("vite/package.json")), "bin/vite.js"),
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--strictPort",
        ],
        {
          cwd: STUDIO_DIR,
          env: { ...minimalEnvironment(), MPVFX_PROJECTS_DIR: projectsRoot },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      serverProcess.stdout.on("data", (chunk) =>
        serverOutput.push(chunk.toString()),
      );
      serverProcess.stderr.on("data", (chunk) =>
        serverOutput.push(chunk.toString()),
      );
      await waitForHttp(studioUrl, serverProcess, serverOutput);
    }
    const sidecarResponse = await fetch(
      `${studioUrl}/api/projects/${PROJECT_ID}/files/${encodeURIComponent(NATIVE_PROJECT_FILE)}?optional=1`,
    );
    const sidecarBody = await sidecarResponse.text();
    const servedSidecar = sidecarResponse.ok
      ? JSON.parse(JSON.parse(sidecarBody).content)
      : null;
    assert(
      sidecarResponse.ok &&
        servedSidecar?.id === "project:native-keyframe-workflow",
      `Studio could not serve the seeded native sidecar (${sidecarResponse.status}): ${sidecarBody}`,
    );

    if (!ELECTRON_MODE) {
      browser = await puppeteer.launch({
        executablePath: await availableExecutable(),
        headless: true,
        args: ["--no-sandbox"],
      });
      page = await browser.newPage();
      await page.setViewport({ width: 1600, height: 1000 });
    }
    console.log(
      `KEYFRAME_ENVIRONMENT ${process.platform}/${process.arch} ${ELECTRON_MODE ? "native Electron" : "browser"} ${await browser.version()}`,
    );
    const pageErrors = [];
    const failedResponses = [];
    const pendingMutations = new Set();
    let lastMutationAt = 0;
    page.on("request", (request) => {
      if (request.method() === "GET" || !request.url().includes("/file-transactions/")) return;
      pendingMutations.add(request);
      lastMutationAt = Date.now();
    });
    const finishedMutation = (request) => {
      if (pendingMutations.delete(request)) lastMutationAt = Date.now();
    };
    page.on("requestfinished", finishedMutation);
    page.on("requestfailed", finishedMutation);
    const waitForSettledWrites = () => waitUntil(
      async () => pendingMutations.size === 0 && Date.now() - lastMutationAt >= 250,
      "Save/history acknowledgements did not settle before reopening the project",
    );
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      const status = response.status();
      const transaction = response
        .url()
        .match(
          /\/file-transactions\/(commit|pending-history|[^/]+\/acknowledge)(?:\?|$)/,
        )?.[1];
      const action = transaction?.endsWith("/acknowledge")
        ? "acknowledge"
        : transaction;
      if (status >= 500)
        failedResponses.push(`${status} ${action ?? "server-response"}`);
      if (transaction && status >= 400) {
        void response
          .json()
          .catch(() => ({}))
          .then((body) => {
            const allowed = new Set([
              "EACCES",
              "EPERM",
              "EBUSY",
              "ENOSPC",
              "EIO",
              "ENOENT",
              "EEXIST",
              "EMFILE",
              "ENFILE",
            ]);
            console.log(
              `KEYFRAME_TRANSACTION_FAILURE ${JSON.stringify({ status, action, code: allowed.has(body.code) ? body.code : "unclassified" })}`,
            );
          });
      }
    });
    await page.goto(`${studioUrl}/#project/${PROJECT_ID}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForSelector(
      'pierce/[data-clip="true"][data-el-id$="#native-video"]',
      { timeout: 20_000 },
    );
    await captureUi(page, "initial");
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
                    ?.getAttribute("data-studio-clip-id") ===
                  "clip:native-video"
                )
                  return true;
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
                  const video =
                    iframe.contentDocument?.querySelector("#native-video");
                  if (video) {
                    return {
                      nativeClipId: video.getAttribute("data-studio-clip-id"),
                      nativeOwned: video.getAttribute(
                        "data-studio-native-owned",
                      ),
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
    const reveal = await page.$(
      'pierce/button[aria-label^="Show "][aria-label$=" lanes"]',
    );
    if (reveal) await reveal.click();
    await page.waitForSelector(
      'pierce/[data-timeline-property-lane][data-property-group="rotation"]',
      {
        timeout: 15_000,
      },
    );
    await page.waitForSelector(
      'pierce/button[aria-label="rotation keyframe at 0s"]',
      {
        timeout: 15_000,
      },
    );
    await page.waitForSelector(
      'pierce/button[aria-label="rotation keyframe at 2s"]',
      {
        timeout: 15_000,
      },
    );

    // Frame 30 lies exactly halfway between frame 0 and frame 60 at 30 fps.
    await requestSeek(page, 1);
    const midpoint = await readNativeVideoState(page);
    assert(
      midpoint?.nativeClipId === "clip:native-video",
      "Native sidecar did not bind the media clip",
    );
    assert(
      midpoint.nativeOwned?.split(/\s+/).includes("transform.rotation"),
      `Native runtime did not claim the rotation channel: ${JSON.stringify(midpoint)}`,
    );
    assert(
      midpoint.transform.includes("rotate(-90deg)"),
      `Frame-30 midpoint was not exact linear -90deg: ${midpoint.transform}`,
    );

    // Pause/play and repeated exact seeks must reproduce identical frame state.
    await page.click('pierce/button[aria-label="Play"]');
    await page.waitForSelector('pierce/button[aria-label="Pause"]');
    await page.click('pierce/button[aria-label="Pause"]');
    await page.waitForSelector('pierce/button[aria-label="Play"]');
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
    const connector = await page.$("pierce/button[data-keyframe-ease-button]");
    assert(
      connector,
      "Native rotation lane did not expose its outgoing interpolation control",
    );
    await connector.click();
    await page.waitForSelector("pierce/[data-native-interpolation-editor]", {
      timeout: 10_000,
    });
    await page.select(
      'pierce/[data-native-interpolation-editor] select[aria-label="Keyframe easing"]',
      "hold",
    );

    await waitUntil(async () => {
      const saved = await readPersistedJson(nativePath);
      return (
        saved.revision === 1 &&
        saved.sequence.tracks[0].clips[0].parameterTracks[0].keyframes[0]
          .outgoing.type === "hold"
      );
    }, "Native outgoing interpolation edit never reached durable project state");
    assert(
      (await readFile(sourcePath, "utf8")) === sourceBefore,
      "Native interpolation edit unexpectedly rewrote compatibility HTML",
    );
    await requestSeek(page, 1);
    await waitUntil(
      async () =>
        (await readNativeVideoState(page))?.transform.includes("rotate(0deg)"),
      "Committed Hold interpolation did not refresh the native preview",
    );

    const saved = await readPersistedJson(nativePath);
    assert(
      saved.revision === 1,
      `Expected one durable native revision, found ${saved.revision}`,
    );
    assert(
      pageErrors.length === 0,
      `Browser page errors:\n${pageErrors.join("\n")}`,
    );
    assert(
      failedResponses.length === 0,
      `Server failures:\n${failedResponses.join("\n")}`,
    );
    console.log(
      "PASS native keyframes: visible non-GSAP lanes and exact frame-30 interpolation",
    );
    console.log(
      "PASS native keyframes: deterministic pause/reseek on the bound media clip",
    );
    console.log(
      "PASS native keyframes: source/outgoing UI edit persisted one sidecar revision",
    );
    // The A/B workflow owns a separate project and undo/transaction history.
    // Never replace a live project's sidecar revision underneath its session.
    const abProjectDir = join(projectsRoot, AB_PROJECT_ID);
    await mkdir(join(abProjectDir, ".studio"), { recursive: true });
    await cp(join(projectDir, "assets"), join(abProjectDir, "assets"), {
      recursive: true,
    });
    await cp(join(projectDir, "vendor"), join(abProjectDir, "vendor"), {
      recursive: true,
    });
    await writeFile(
      join(abProjectDir, PROJECT_FILE),
      projectSource(AB_PROJECT_ID),
    );
    const fresh = nativeProject(AB_PROJECT_ID);
    fresh.sequence.tracks[0].clips[0].parameterTracks = [];
    nativePath = join(abProjectDir, NATIVE_PROJECT_FILE);
    await writeFile(nativePath, `${JSON.stringify(fresh, null, 2)}\n`);
    await page.goto(`${studioUrl}/?workflow=ab#project/${AB_PROJECT_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await selectByDomId(page, "native-video");
    await requestSeek(page, 0);
    const autoKeyframe = await page.waitForSelector(
      'pierce/button[aria-label="Auto-record manual edits as keyframes"]',
    );
    if (
      (await autoKeyframe.evaluate((button) =>
        button.getAttribute("aria-pressed"),
      )) === "true"
    )
      await autoKeyframe.click();
    const readSaved = () => readPersistedJson(nativePath);
    const savedTrack = async (parameter) =>
      (await readSaved()).sequence.tracks[0].clips[0].parameterTracks.find(
        (track) => track.parameterId === parameter,
      );
    if (DELAY_KEYFRAME_RESPONSE_MS > 0) {
      const delaySession = await page.createCDPSession();
      await delaySession.send("Fetch.enable", {
        patterns: [
          {
            urlPattern: "*/file-transactions/commit",
            requestStage: "Response",
          },
        ],
      });
      delaySession.on("Fetch.requestPaused", (event) => {
        setTimeout(
          () =>
            void delaySession
              .send("Fetch.continueRequest", { requestId: event.requestId })
              .catch(() => undefined),
          DELAY_KEYFRAME_RESPONSE_MS,
        );
      });
    }
    const clickToolbar = async (time) => {
      await traceWorkflow(page, "toolbar-before");
      const button = await page.waitForSelector(
        'pierce/button[aria-label="Add keyframe at playhead"]',
        {
          timeout: 5_000,
        },
      );
      const revision = (await readSaved()).revision;
      await button.click();
      await waitUntil(
        async () => (await readSaved()).revision === revision + 1,
        "Toolbar keyframe did not persist exactly once",
      );
      await traceWorkflow(page, "toolbar-durable");
      const trackGroups = new Set(
        (await readSaved()).sequence.tracks[0].clips[0].parameterTracks.map(
          (track) =>
            track.parameterId.startsWith("transform.position.")
              ? "position"
              : track.parameterId === "transform.rotation"
                ? "rotation"
                : track.parameterId.startsWith("layout.")
                  ? "size"
                  : "scale",
        ),
      );
      await waitUntil(async () => {
        const state = await readNativeVideoState(page);
        const ui = await readWorkflowUiState(page);
        return (
          Math.floor((state?.nativePlayerTime ?? -1) * 30 + 1e-6) ===
            Math.round(time * 30) &&
          ui.toolbar === "Remove keyframe at playhead" &&
          [...trackGroups].every((group) =>
            ui.keys.some(
              (key) =>
                key.group === group &&
                Number(key.percentage) === (time / 4) * 100,
            ),
          )
        );
      }, "Saved toolbar keyframes did not reach the rendered timeline");
      await traceWorkflow(page, "toolbar-rendered");
    };
    await clickToolbar(0);
    await requestSeek(page, 2);
    await clickToolbar(2);

    // The original report is a canvas workflow. Move and rotate the real
    // selection at B with auto-key off, then verify that A is untouched.
    const box = await page.waitForSelector(
      'pierce/[data-dom-edit-selection-box="true"]',
    );
    const rect = await box.boundingBox();
    assert(rect, "No canvas selection bounds");
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      rect.x + rect.width / 2 + 30,
      rect.y + rect.height / 2 + 15,
      {
        steps: 12,
      },
    );
    await page.mouse.up();
    await waitUntil(
      async () =>
        (await savedTrack("transform.position.x"))?.keyframes.some(
          (key) => key.frame === 60 && key.value !== 0,
        ),
      "Canvas move did not edit B",
    );

    await page.bringToFront();
    const rotate = await page.waitForSelector(
      'pierce/button[aria-label="Rotate selection"]',
    );
    await rotate.scrollIntoView();
    await rotate.dispose();
    // React can replace the overlay after the drag's disk save. Re-query the
    // live button on every bounded sample instead of waiting in requestAnimationFrame
    // on a retained (possibly detached) ElementHandle or a backgrounded renderer.
    let previousGeometry,
      stableSamples = 0,
      rotationGeometry;
    try {
      await waitUntil(
        async () => {
          rotationGeometry = await page.evaluate(() => {
            const roots = [document];
            let handle, selection;
            for (let index = 0; index < roots.length; index += 1) {
              for (const element of roots[index].querySelectorAll("*")) {
                if (element.shadowRoot) roots.push(element.shadowRoot);
                if (element.matches('button[aria-label="Rotate selection"]'))
                  handle = element;
                if (element.matches('[data-dom-edit-selection-box="true"]'))
                  selection = element;
              }
            }
            if (!handle?.isConnected || !selection?.isConnected) return null;
            const bounds = (element) => {
              const rect = element.getBoundingClientRect();
              return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              };
            };
            const rect = bounds(handle);
            let target = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            );
            while (target?.shadowRoot) {
              const next = target.shadowRoot.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              );
              if (!next || next === target) break;
              target = next;
            }
            return {
              handle: rect,
              selection: bounds(selection),
              hittable: target === handle || handle.contains(target),
              hitTag: target?.tagName ?? null,
              hitLabel: target?.getAttribute("aria-label") ?? null,
              documentHidden: document.hidden,
            };
          });
          const current = rotationGeometry;
          const isStable =
            current?.hittable &&
            current.handle.width > 0 &&
            current.handle.height > 0 &&
            previousGeometry &&
            ["handle", "selection"].every((part) =>
              ["x", "y", "width", "height"].every(
                (key) =>
                  Math.abs(current[part][key] - previousGeometry[part][key]) <
                  0.1,
              ),
            );
          stableSamples = isStable ? stableSamples + 1 : 0;
          previousGeometry = current;
          return stableSamples >= 4;
        },
        "Rotation handle did not become a stable live hit target",
        10_000,
      );
    } catch (error) {
      throw new Error(
        `Rotation handle readiness failed: ${JSON.stringify(rotationGeometry)}`,
        { cause: error },
      );
    }
    const handle = rotationGeometry.handle;
    const moved = rotationGeometry.selection;
    const center = {
      x: moved.x + moved.width / 2,
      y: moved.y + moved.height / 2,
    };
    const start = {
      x: handle.x + handle.width / 2,
      y: handle.y + handle.height / 2,
    };
    const vector = { x: start.x - center.x, y: start.y - center.y };
    const angle = Math.PI / 4;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(
      center.x + vector.x * Math.cos(angle) - vector.y * Math.sin(angle),
      center.y + vector.x * Math.sin(angle) + vector.y * Math.cos(angle),
      { steps: 12 },
    );
    await page.mouse.up();
    await waitUntil(
      async () =>
        (await savedTrack("transform.rotation"))?.keyframes.some(
          (key) => key.frame === 60 && Math.abs(key.value) > 20,
        ),
      "Canvas rotation did not create an animated B pose",
    );

    const editField = async (label, value, parameter) => {
      const input = await page.waitForSelector(
        `pierce/input[aria-label="${label}"]`,
      );
      const revision = (await readSaved()).revision;
      await input.click();
      await input.evaluate((node) => node.select());
      await input.type(value);
      await input.press("Enter");
      await waitUntil(
        async () =>
          (await readSaved()).revision > revision &&
          (await savedTrack(parameter))?.keyframes.some(
            (key) => key.frame === 60,
          ),
        `${label} did not persist a key at B`,
      );
      const expected = (await savedTrack(parameter)).keyframes.find(
        (key) => key.frame === 60,
      ).value;
      await waitUntil(async () => {
        const state = await readNativeVideoState(page);
        return (
          state?.nativeOwned?.split(/\s+/).includes(parameter) &&
          (parameter === "layout.width"
            ? state.width === expected
            : state.transform.includes(`scale(${expected}, ${expected})`))
        );
      }, `${label} saved but did not reach the native preview at B`);
    };
    await editField("W", "320", "layout.width");
    await editField("Scale", "150", "transform.scale");
    const edited = await readSaved();
    const tracks = edited.sequence.tracks[0].clips[0].parameterTracks;
    const expectedA = {
      "transform.position.x": 0,
      "transform.position.y": 0,
      "transform.rotation": 0,
      "layout.width": 640,
      "transform.scale": 1,
    };
    for (const [parameter, baseline] of Object.entries(expectedA)) {
      const track = tracks.find((item) => item.parameterId === parameter);
      assert(
        track?.keyframes.find((key) => key.frame === 0)?.value === baseline,
        `${parameter} changed key A: expected ${baseline}, received ${track?.keyframes.find((key) => key.frame === 0)?.value}`,
      );
      assert(
        track.keyframes.some(
          (key) => key.frame === 60 && key.value !== baseline,
        ),
        `${parameter} did not change key B`,
      );
    }
    await requestSeek(page, 0);
    await waitUntil(
      async () => (await readNativeVideoState(page))?.width === 640,
      "Pose A width was not preserved",
    );
    const poseA = await readNativeVideoState(page);
    await captureUi(page, "pose-a");
    await requestSeek(page, 1);
    await waitUntil(
      async () => (await readNativeVideoState(page))?.width === 480,
      "Midpoint size did not interpolate",
    );
    const poseMid = await readNativeVideoState(page);
    for (const parameter of [
      "transform.position.x",
      "transform.position.y",
      "transform.rotation",
    ]) {
      const valueB = tracks
        .find((track) => track.parameterId === parameter)
        .keyframes.find((key) => key.frame === 60).value;
      const component =
        parameter === "transform.rotation"
          ? `rotate(${valueB / 2}deg)`
          : parameter === "transform.position.x"
            ? `translate3d(${valueB / 2}px,`
            : `, ${valueB / 2}px, 0px)`;
      assert(
        poseMid.transform.includes(component),
        `${parameter} did not interpolate halfway: ${poseMid.transform}`,
      );
    }
    await captureUi(page, "pose-midpoint");
    assert(
      poseMid.transform.includes("scale(1.25, 1.25)"),
      `Midpoint scale did not interpolate: ${poseMid.transform}`,
    );
    await requestSeek(page, 2);
    await waitUntil(
      async () => (await readNativeVideoState(page))?.width === 320,
      "Pose B width did not persist",
    );
    const poseB = await readNativeVideoState(page);
    await captureUi(page, "pose-b");
    assert(
      poseA.transform !== poseMid.transform &&
        poseMid.transform !== poseB.transform,
      "Transform poses did not interpolate",
    );

    // At an intermediate frame the general button must capture every animated
    // channel in one revision. Removing it must restore the original curves.
    await requestSeek(page, 1);
    await clickToolbar(1);
    const withMiddle = await readSaved();
    assert(
      withMiddle.sequence.tracks[0].clips[0].parameterTracks.every((track) =>
        track.keyframes.some((key) => key.frame === 30),
      ),
      "General toolbar omitted an animated property",
    );
    const removeMiddle = await page.waitForSelector(
      'pierce/button[aria-label="Remove keyframe at playhead"]',
    );
    await removeMiddle.click();
    await waitUntil(
      async () => (await readSaved()).revision === withMiddle.revision + 1,
      "Removing all middle keys was not one save",
    );
    assert(
      (await readSaved()).sequence.tracks[0].clips[0].parameterTracks.every(
        (track) => !track.keyframes.some((key) => key.frame === 30),
      ),
      "General toolbar left some middle keys behind",
    );

    const waitForMiddleRendered = async (present) => {
      await waitUntil(
        async () => {
          const ui = await readWorkflowUiState(page);
          const middle = ui.keys.filter((key) => Number(key.percentage) === 25);
          return present
            ? ui.toolbar === "Remove keyframe at playhead" &&
                ["position", "rotation", "scale", "size"].every((group) =>
                  middle.some((key) => key.group === group),
                )
            : ui.toolbar === "Add keyframe at playhead" && middle.length === 0;
        },
        `Middle keyframes did not render as ${present ? "present" : "removed"}`,
      );
    };
    await waitForMiddleRendered(false);
    await traceWorkflow(page, "middle-removed-rendered");

    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    await page.keyboard.press("z");
    await page.keyboard.up(modifier);
    await waitUntil(
      async () =>
        (await readSaved()).sequence.tracks[0].clips[0].parameterTracks.every(
          (track) => track.keyframes.some((key) => key.frame === 30),
        ),
      "Undo did not restore all middle keys together",
    );
    await waitForMiddleRendered(true);
    await traceWorkflow(page, "undo-rendered");
    await page.keyboard.down(modifier);
    await page.keyboard.down("Shift");
    await page.keyboard.press("z");
    await page.keyboard.up("Shift");
    await page.keyboard.up(modifier);
    await waitUntil(
      async () =>
        (await readSaved()).sequence.tracks[0].clips[0].parameterTracks.every(
          (track) => !track.keyframes.some((key) => key.frame === 30),
        ),
      "Redo did not remove all middle keys together",
    );
    await waitForMiddleRendered(false);
    await traceWorkflow(page, "redo-rendered");

    await waitForSettledWrites();
    await page.reload({ waitUntil: "domcontentloaded" });
    await selectByDomId(page, "native-video");
    await requestSeek(page, 1);
    await waitUntil(
      async () => (await readNativeVideoState(page))?.width === 480,
      "Reopened project lost interpolation",
    );
    assert(
      (await readNativeVideoState(page)).transform === poseMid.transform,
      "Reopened project changed the interpolated transform",
    );
    assert(
      pageErrors.length === 0,
      `Browser page errors:\n${pageErrors.join("\n")}`,
    );
    console.log(
      "PASS native A/B workflow: canvas move and rotate, inspector width and scale, preserved A, interpolated midpoint, saved and reopened B",
    );
    console.log(
      "PASS general toolbar: all animated channels added, removed, undone and redone atomically",
    );
    assert(
      failedResponses.length === 0,
      `Server failures:\n${failedResponses.join("\n")}`,
    );
    await captureUi(page, "reopened-midpoint");
    await verifyProfessionalTimeline({ page, readSaved, selectByDomId, requestSeek, waitUntil, waitForSettledWrites, assert });
    assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join("\n")}`);
    assert(failedResponses.length === 0, `Server failures: ${failedResponses.join("\n")}`);
    await writeFile(
      join(OUTPUT_DIR, "result.json"),
      JSON.stringify(
        {
          mode: ELECTRON_MODE ? "electron" : "browser",
          platform: process.platform,
          architecture: process.arch,
          electronVersion: ELECTRON_MODE
            ? require("electron/package.json").version
            : null,
          browser: await browser.version(),
          appVersion: JSON.parse(
            await readFile(join(STUDIO_DIR, "package.json"), "utf8"),
          ).version,
          passed: [
            "visible-native-lanes",
            "exact-midpoint",
            "pause-reseek",
            "outgoing-interpolation-persistence",
            "canvas-position",
            "canvas-rotation",
            "inspector-width",
            "inspector-scale",
            "preserved-pose-a",
            "all-channel-keyframe-add-remove",
            "atomic-undo-redo",
            "save-reopen",
            "keyframe-clipboard-and-scoped-delete",
            "clip-copy-cut-duplicate",
            "complete-curve-split-and-reopen",
            "select-delete-all-and-undo",
          ],
          poseA,
          poseMid,
          poseB,
          parameterTracks: tracks,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (page && !page.isClosed())
      await traceWorkflow(page, "failure").catch(() => undefined);
    if (page && !page.isClosed())
      await captureUi(page, "failure").catch(() => undefined);
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(join(OUTPUT_DIR, "application.log"), serverOutput.join(""));
    throw error;
  } finally {
    if (browser) {
      if (ELECTRON_MODE) browser.disconnect();
      else await browser.close().catch(() => undefined);
    }
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveExit) => serverProcess.once("exit", resolveExit)),
        new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
      ]);
      if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
    }
    await rm(scratchRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
