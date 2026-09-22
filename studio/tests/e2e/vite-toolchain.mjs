#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, preview } from "vite";
import puppeteer from "puppeteer";

// Exercise the installed application Vite, not Vitest's private Vite dependency.
// Use a disposable project so smoke checks never read or edit personal projects.
const studioDir = resolve(import.meta.dirname, "../..");
const projectsDir = await mkdtemp(join(tmpdir(), "mpvfx-vite-toolchain-"));
const previousProjectsDir = process.env.MPVFX_PROJECTS_DIR;
process.env.MPVFX_PROJECTS_DIR = projectsDir;
let devServer;
let previewServer;
let browser;

function origin(server) {
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function checkEditor(url, label) {
  console.log(`Checking ${label}`);
  const runtime = await fetch(`${url}/api/runtime.js`);
  assert(runtime.ok, `${label}: playback runtime returned ${runtime.status}`);
  assert.match(runtime.headers.get("content-type") ?? "", /javascript/);
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().startsWith(url)) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  try {
    await page.setViewport({ width: 1440, height: 1000 });
    // The project API can hold event streams open; readiness is the editor and
    // rendered scene below, not an idle network connection count.
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assert(response.ok(), `${label}: editor document failed to load`);
    await page.waitForSelector('[aria-label="Resize sidebar"]', { timeout: 30_000 });
    // The player renders inside a shadow root. Require its actual scene to load,
    // so an empty shell or a broken player chunk cannot satisfy the smoke check.
    await page.waitForFunction(() => {
      const roots = [document];
      for (let i = 0; i < roots.length; i += 1) {
        for (const element of roots[i].querySelectorAll("*")) {
          if (element.shadowRoot) roots.push(element.shadowRoot);
          if (element.tagName === "IFRAME") {
            try {
              if (
                element.contentWindow?.__hyperframeRuntimeBootstrapped === true &&
                element.contentDocument?.querySelector('[data-composition-id="main"]')
              ) return true;
            } catch { /* Only same-origin editor scenes count. */ }
          }
        }
      }
      return false;
    }, { timeout: 30_000 });
    assert.deepEqual(errors, [], `${label}: browser/runtime failures`);
    console.log(`PASS ${label}: React editor, project API, and player scene`);
  } catch (error) {
    console.error(`${label}: ${errors.join("\n") || "editor did not become ready"}`);
    throw error;
  } finally {
    await page.close();
  }
}

try {
  devServer = await createServer({
    root: studioDir,
    server: { host: "127.0.0.1", port: 0, open: false },
  });
  await devServer.listen();
  const devOrigin = origin(devServer.httpServer);
  const response = await fetch(`${devOrigin}/api/projects`);
  assert(response.ok, `Project API returned ${response.status}`);
  assert((await response.json()).projects.some((project) => project.id === "MpVFX"));

  browser = await puppeteer.launch({
    headless: "shell",
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  await checkEditor(devOrigin, "Vite development");
  previewServer = await preview({
    root: studioDir,
    configFile: false,
    preview: {
      host: "127.0.0.1", port: 0, open: false,
      proxy: { "/api": devOrigin },
    },
  });
  await checkEditor(origin(previewServer.httpServer), "Vite production bundle");
} finally {
  await browser?.close();
  if (previewServer) {
    await new Promise((resolveClose, reject) => {
      previewServer.httpServer.close((error) => error ? reject(error) : resolveClose());
      previewServer.httpServer.closeAllConnections();
    });
  }
  await devServer?.close();
  if (previousProjectsDir === undefined) delete process.env.MPVFX_PROJECTS_DIR;
  else process.env.MPVFX_PROJECTS_DIR = previousProjectsDir;
  await rm(projectsDir, { recursive: true, force: true });
}
