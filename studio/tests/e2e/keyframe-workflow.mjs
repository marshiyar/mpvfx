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
const SOURCE_FIXTURE = join(STUDIO_DIR, "tests/e2e/fixtures/design-panel-qa");
const SOURCE_GSAP = join(STUDIO_DIR, "fixtures/vendor/gsap.min.js");
const PROJECT_ID = "design-panel-qa";
const PROJECT_FILE = "index.html";
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

async function waitUntil(predicate, message, timeoutMs = 12_000) {
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
    (nextTime) => Math.abs(window.__playerStore.getState().currentTime - nextTime) < 0.02,
    { timeout: 5_000 },
    time,
  );
}

async function pressShortcut(page, keys) {
  const modifiers = keys.slice(0, -1);
  const key = keys.at(-1);
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of modifiers.toReversed()) await page.keyboard.up(modifier);
}

async function previewTransform(page) {
  return page.evaluate(() => {
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      for (const iframe of root.querySelectorAll("iframe")) {
        try {
          const target = iframe.contentDocument?.querySelector("#qa-zone-keyframe");
          if (target) return target.style.transform;
        } catch {
          // Cross-origin frames are not the local preview.
        }
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    return null;
  });
}

async function main() {
  const scratchRoot = await mkdtemp(join(tmpdir(), "studio-keyframe-workflow-"));
  const projectDir = join(scratchRoot, PROJECT_ID);
  const sourcePath = join(projectDir, PROJECT_FILE);
  let browser;
  let serverProcess;
  const serverOutput = [];

  try {
    await cp(SOURCE_FIXTURE, projectDir, { recursive: true });
    await mkdir(join(projectDir, "vendor"), { recursive: true });
    await cp(SOURCE_GSAP, join(projectDir, "vendor/gsap.min.js"));
    const fixtureSource = (await readFile(sourcePath, "utf8")).replace(
      "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
      "vendor/gsap.min.js",
    );
    await writeFile(sourcePath, fixtureSource);

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

    // Selection exposes one predictable, property-scoped lane and keeps manual
    // edits out of auto-keyframe mode until the user explicitly opts in.
    await selectByDomId(page, "qa-zone-keyframe");
    const initial = await page.evaluate(() => {
      const state = window.__playerStore.getState();
      return {
        autoKeyframeEnabled: state.autoKeyframeEnabled,
        keyframes: state.keyframeCache.get("index.html#qa-zone-keyframe")?.keyframes ?? [],
      };
    });
    assert(initial.autoKeyframeEnabled === false, "Auto-keyframe must default off");
    assert(initial.keyframes.length === 3, "Expected three authored position keyframes");
    const addToolbar = await page.$('button[aria-label="Add keyframe at playhead"]');
    assert(addToolbar && !(await addToolbar.evaluate((button) => button.disabled)), "Add keyframe must be enabled for the selected animated layer");

    // A plain click seeks/selects one exact key; Shift-click adds selection and
    // deliberately preserves the playhead.
    await page.click('button[aria-label="position keyframe at 2s"]');
    const single = await page.evaluate(() => {
      const state = window.__playerStore.getState();
      return {
        currentTime: state.currentTime,
        activeKeyframePct: state.activeKeyframePct,
        selected: [...state.selectedKeyframes],
      };
    });
    assert(Math.abs(single.currentTime - 2.001) < 0.02, "Diamond click did not seek to its exact key time");
    assert(single.activeKeyframePct === 66.7, "Diamond click lost tween-relative identity");
    assert(single.selected.length === 1, "Plain diamond click must replace keyframe selection");
    await page.keyboard.down("Shift");
    await page.click('button[aria-label="position keyframe at 3s"]');
    await page.keyboard.up("Shift");
    const additive = await page.evaluate(() => {
      const state = window.__playerStore.getState();
      return { currentTime: state.currentTime, selected: [...state.selectedKeyframes] };
    });
    assert(additive.selected.length === 2, "Shift-click must add a second keyframe selection");
    assert(Math.abs(additive.currentTime - single.currentTime) < 0.001, "Shift-click must not move the playhead");

    // Segment ease focus is not navigation: selecting it keeps the playhead and
    // records the exact destination keyframe/animation identity.
    const easeButton = await page.$('button[data-keyframe-ease-button]');
    assert(easeButton, "Expected an incoming-segment easing control");
    await easeButton.click();
    await page.waitForSelector(
      '[data-ease-segment-pct] > button[aria-expanded="true"]',
      { timeout: 5_000 },
    );
    const focusedEase = await page.evaluate(() => ({
      // The request is intentionally one-shot: the inspector consumes it once
      // the exact incoming segment is visible. Assert the user-visible result,
      // not the transient dispatch state.
      request: window.__playerStore.getState().focusedEaseSegment,
      segment: document
        .querySelector('[data-ease-segment-pct] > button[aria-expanded="true"]')
        ?.closest('[data-ease-segment-pct]')
        ?.getAttribute("data-ease-segment-pct"),
    }));
    assert(focusedEase.request === null, "Consumed ease focus request remained stale in the store");
    assert(focusedEase.segment === "66.7", "Ease control opened the wrong incoming segment");
    const afterEaseTime = await page.evaluate(() => window.__playerStore.getState().currentTime);
    assert(Math.abs(afterEaseTime - single.currentTime) < 0.001, "Ease focus unexpectedly moved the playhead");

    // A context menu is scoped to the selected clip/session and cannot survive
    // a switch to another layer where its stale commands would mutate the wrong file.
    await page.click('button[aria-label="position keyframe at 2s"]', { button: "right" });
    await page.waitForSelector('[role="menu"][aria-label="Keyframe actions"]');
    await selectByDomId(page, "qa-zone-shape");
    await page.waitForFunction(
      () => !document.querySelector('[role="menu"][aria-label="Keyframe actions"]'),
      { timeout: 5_000 },
    );
    const switched = await page.evaluate(() => {
      const state = window.__playerStore.getState();
      return {
        selectedKeyframes: state.selectedKeyframes.size,
        activeKeyframePct: state.activeKeyframePct,
        focusedEaseSegment: state.focusedEaseSegment,
      };
    });
    assert(switched.selectedKeyframes === 0, "Clip switch retained stale keyframe selection");
    assert(switched.activeKeyframePct === null, "Clip switch retained stale active-key identity");
    assert(switched.focusedEaseSegment === null, "Clip switch retained stale ease focus");

    // Pausing and re-seeking the same frame must reproduce the same rendered
    // transform; playback wall-clock timing must not become keyframe state.
    await selectByDomId(page, "qa-zone-keyframe");
    await requestSeek(page, 1.5);
    const transformBeforePlayback = await previewTransform(page);
    assert(transformBeforePlayback, "Could not read the keyframed preview transform");
    await page.evaluate(() => window.__playerStore.getState().requestPlayback(true));
    await page.waitForFunction(() => window.__playerStore.getState().isPlaying, { timeout: 5_000 });
    await page.evaluate(() => window.__playerStore.getState().requestPlayback(false));
    await page.waitForFunction(() => !window.__playerStore.getState().isPlaying, { timeout: 5_000 });
    await requestSeek(page, 1.5);
    const transformAfterPlayback = await previewTransform(page);
    assert(
      transformAfterPlayback === transformBeforePlayback,
      `Pause/seek was nondeterministic: ${transformBeforePlayback} -> ${transformAfterPlayback}`,
    );

    // Add through the real toolbar, then undo and redo through the app hotkeys.
    // Each transition must update both the durable source and visible cache.
    await requestSeek(page, 0);
    await page.click('button[aria-label="Add keyframe at playhead"]');
    await page.waitForFunction(
      () =>
        window.__playerStore
          .getState()
          .keyframeCache.get("index.html#qa-zone-keyframe")
          ?.keyframes.some((keyframe) => Math.abs(keyframe.percentage) < 0.001),
      { timeout: 15_000 },
    );

    await waitUntil(
      async () => (await readFile(sourcePath, "utf8")).includes('"0%"'),
      "Added keyframe never reached the project source",
    );

    await pressShortcut(page, ["Meta", "z"]);
    await waitUntil(
      async () => !(await readFile(sourcePath, "utf8")).includes('"0%"'),
      "Undo did not restore the pre-keyframe source",
      15_000,
    );
    await page.waitForFunction(
      () =>
        !window.__playerStore
          .getState()
          .keyframeCache.get("index.html#qa-zone-keyframe")
          ?.keyframes.some((keyframe) => Math.abs(keyframe.percentage) < 0.001),
      { timeout: 15_000 },
    );

    await pressShortcut(page, ["Meta", "Shift", "z"]);
    await waitUntil(
      async () => (await readFile(sourcePath, "utf8")).includes('"0%"'),
      "Redo did not restore the added keyframe source",
      15_000,
    );
    await page.waitForFunction(
      () =>
        window.__playerStore
          .getState()
          .keyframeCache.get("index.html#qa-zone-keyframe")
          ?.keyframes.some((keyframe) => Math.abs(keyframe.percentage) < 0.001),
      { timeout: 15_000 },
    );

    // Delete the exact key through the real timeline selection/hotkey path,
    // then prove both history directions settle all the way through the source
    // writer and authoritative cache. This catches the class of bugs where the
    // diamond disappears optimistically while the durable key survives (or an
    // undo restores source bytes without restoring the editor model).
    await page.click('button[aria-label="position keyframe at 0s"]');
    await page.keyboard.press("Backspace");
    await waitUntil(
      async () => !(await readFile(sourcePath, "utf8")).includes('"0%"'),
      "Delete did not remove the exact keyframe from project source",
      15_000,
    );
    await page.waitForFunction(
      () =>
        !window.__playerStore
          .getState()
          .keyframeCache.get("index.html#qa-zone-keyframe")
          ?.keyframes.some((keyframe) => Math.abs(keyframe.percentage) < 0.001),
      { timeout: 15_000 },
    );

    await pressShortcut(page, ["Meta", "z"]);
    await waitUntil(
      async () => (await readFile(sourcePath, "utf8")).includes('"0%"'),
      "Undo did not restore the deleted keyframe source",
      15_000,
    );
    await page.waitForFunction(
      () =>
        window.__playerStore
          .getState()
          .keyframeCache.get("index.html#qa-zone-keyframe")
          ?.keyframes.some((keyframe) => Math.abs(keyframe.percentage) < 0.001),
      { timeout: 15_000 },
    );

    await pressShortcut(page, ["Meta", "Shift", "z"]);
    await waitUntil(
      async () => !(await readFile(sourcePath, "utf8")).includes('"0%"'),
      "Redo did not remove the keyframe source again",
      15_000,
    );
    await page.waitForFunction(
      () =>
        !window.__playerStore
          .getState()
          .keyframeCache.get("index.html#qa-zone-keyframe")
          ?.keyframes.some((keyframe) => Math.abs(keyframe.percentage) < 0.001),
      { timeout: 15_000 },
    );

    // Select two authored keys and frame-nudge them as one group. The source
    // must change in one durable transaction, cache and selection must re-key
    // together, and Undo must not leave stale post-nudge identities.
    const groupNudgeSourceBefore = await readFile(sourcePath, "utf8");
    await page.waitForSelector('button[aria-label="position keyframe at 1s"]', {
      timeout: 15_000,
    });
    await page.waitForSelector('button[aria-label="position keyframe at 2s"]', {
      timeout: 15_000,
    });
    const groupNudgeLaneSelector = await page.evaluate(() => {
      const groupedOne = document.querySelector(
        'button[data-keyframe-group="position"][aria-label="position keyframe at 1s"]',
      );
      const groupedTwo = document.querySelector(
        'button[data-keyframe-group="position"][aria-label="position keyframe at 2s"]',
      );
      return groupedOne && groupedTwo
        ? 'button[data-keyframe-group="position"]'
        : "button:not([data-keyframe-group])";
    });
    await page.click(
      `${groupNudgeLaneSelector}[aria-label="position keyframe at 1s"]`,
    );
    await page.keyboard.down("Shift");
    await page.click(
      `${groupNudgeLaneSelector}[aria-label="position keyframe at 2s"]`,
    );
    await page.keyboard.up("Shift");
    const groupNudgeBefore = await page.evaluate(() => {
      const state = window.__playerStore.getState();
      return {
        selected: [...state.selectedKeyframes],
        cachePercentages:
          state.keyframeCache
            .get("index.html#qa-zone-keyframe")
            ?.keyframes.map((keyframe) => keyframe.percentage)
            .sort((a, b) => a - b) ?? [],
        activeTweenPercentage: state.activeKeyframeTarget?.tweenPercentage ?? null,
      };
    });
    assert(
      groupNudgeBefore.selected.length === 2,
      `Group nudge did not start with two keys: ${JSON.stringify(groupNudgeBefore)}`,
    );
    await pressShortcut(page, ["."]);
    await waitUntil(
      async () => (await readFile(sourcePath, "utf8")) !== groupNudgeSourceBefore,
      "Group nudge never reached project source",
      15_000,
    );
    await page.waitForFunction(
      (before) => {
        const state = window.__playerStore.getState();
        return (
          state.selectedKeyframes.size === 2 &&
          JSON.stringify([...state.selectedKeyframes]) !== JSON.stringify(before)
        );
      },
      { timeout: 15_000 },
      groupNudgeBefore.selected,
    );
    const groupNudgeAfter = await page.evaluate(() => {
      const state = window.__playerStore.getState();
      return {
        selected: [...state.selectedKeyframes],
        cachePercentages:
          state.keyframeCache
            .get("index.html#qa-zone-keyframe")
            ?.keyframes.map((keyframe) => keyframe.percentage)
            .sort((a, b) => a - b) ?? [],
        activeTweenPercentage: state.activeKeyframeTarget?.tweenPercentage ?? null,
      };
    });
    assert(groupNudgeAfter.selected.length === 2, "Group nudge lost selected keyframes");
    assert(
      JSON.stringify(groupNudgeAfter.cachePercentages) !==
        JSON.stringify(groupNudgeBefore.cachePercentages),
      "Group nudge source changed without re-keying the authoritative cache",
    );
    assert(
      groupNudgeAfter.activeTweenPercentage !== groupNudgeBefore.activeTweenPercentage,
      "Group nudge left the active keyframe on its stale source percentage",
    );

    await pressShortcut(page, ["Meta", "z"]);
    await waitUntil(
      async () => (await readFile(sourcePath, "utf8")) === groupNudgeSourceBefore,
      "Undo did not atomically restore the pre-nudge source",
      15_000,
    );
    await page.waitForFunction(
      (before) => {
        const percentages =
          window.__playerStore
            .getState()
            .keyframeCache.get("index.html#qa-zone-keyframe")
            ?.keyframes.map((keyframe) => keyframe.percentage)
            .sort((a, b) => a - b) ?? [];
        return JSON.stringify(percentages) === JSON.stringify(before);
      },
      { timeout: 15_000 },
      groupNudgeBefore.cachePercentages,
    );
    const selectedAfterNudgeUndo = await page.evaluate(
      () => window.__playerStore.getState().selectedKeyframes.size,
    );
    assert(selectedAfterNudgeUndo === 0, "Undo retained stale post-nudge keyframe selection");

    assert(pageErrors.length === 0, `Browser page errors:\n${pageErrors.join("\n")}`);
    assert(failedResponses.length === 0, `Server failures:\n${failedResponses.join("\n")}`);
    console.log("PASS keyframe workflow: selection, navigation, additive selection, ease focus");
    console.log("PASS keyframe workflow: stale-context isolation and deterministic pause/seek");
    console.log("PASS keyframe workflow: durable add/delete, undo/redo, and cache synchronization");
    console.log("PASS keyframe workflow: atomic group nudge, selection re-key, and clean undo");
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
