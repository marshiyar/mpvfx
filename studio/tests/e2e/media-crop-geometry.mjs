#!/usr/bin/env node
// Uses production gesture handlers in Chromium and checks actual video pixels.
// Optional CHROME_PATH and FFMPEG_PATH reuse installed release executables.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import ffmpeg from "ffmpeg-static";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = await mkdtemp(join(tmpdir(), "mpvfx-crop-test-"));
let server;
let browser;
try {
  const video = join(scratch, "quadrants.webm");
  execFileSync(process.env.FFMPEG_PATH || ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=320x200:d=1,drawbox=x=160:y=0:w=160:h=100:color=lime:t=fill,drawbox=x=0:y=100:w=160:h=100:color=blue:t=fill,drawbox=x=160:y=100:w=160:h=100:color=yellow:t=fill",
    "-c:v",
    "libvpx",
    "-pix_fmt",
    "yuv420p",
    video,
  ]);
  const bytes = await readFile(video);
  server = await createServer({
    root,
    configFile: false,
    optimizeDeps: {
      entries: ["src/components/editor/useDomEditOverlayGestures.ts"],
      include: ["react/jsx-dev-runtime"],
    },
    server: { host: "127.0.0.1", port: 0, hmr: false },
    plugins: [
      {
        name: "crop-pixel-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === "/crop-video.webm") {
              res.setHeader("Content-Type", "video/webm");
              res.end(bytes);
            } else if (req.url === "/crop-test") {
              res.setHeader("Content-Type", "text/html");
              res.end("<body style='margin:0;background:black'></body>");
            } else next();
          });
        },
      },
    ],
  });
  await server.listen();
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH,
    headless: "shell",
    args: process.env.CI ? ["--no-sandbox"] : [],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 240, deviceScaleFactor: 1 });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/crop-test`,
  );
  await page.evaluate(async () => {
    const { createDomEditOverlayGestureHandlers } =
      await import("/src/components/editor/useDomEditOverlayGestures.ts");
    const { orientedOverlayRect } =
      await import("/src/components/editor/domEditOverlayGeometry.ts");
    const { hugOrientedRectForElement } =
      await import("/src/components/editor/domEditOverlayCrop.ts");
    const frame = document.createElement("iframe");
    frame.style.cssText =
      "position:absolute;inset:0;width:400px;height:240px;border:0";
    document.body.append(frame);
    frame.contentDocument.body.style.cssText = "margin:0;background:black";
    const stage = frame.contentDocument.createElement("main");
    stage.setAttribute("data-composition-id", "main");
    stage.setAttribute("data-width", "400");
    stage.setAttribute("data-height", "240");
    stage.style.cssText =
      "position:relative;width:400px;height:240px;overflow:hidden;background:black";
    frame.contentDocument.body.append(stage);
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;inset:0;pointer-events:none";
    document.body.append(overlay);
    const box = document.createElement("div");
    overlay.append(box);
    const ref = (current) => ({ current });
    const noop = () => {};
    let media, handlers, opts;
    const event = (x, y) => ({
      clientX: x,
      clientY: y,
      altKey: true,
      shiftKey: false,
      pointerId: 1,
      preventDefault: noop,
      stopPropagation: noop,
      currentTarget: { setPointerCapture: noop, releasePointerCapture: noop },
    });
    window.cropTest = {
      async reset(cropped) {
        stage.replaceChildren();
        media = frame.contentDocument.createElement("video");
        media.id = "test-video";
        media.muted = true;
        media.style.cssText =
          "position:absolute;left:100px;top:60px;width:160px;height:100px;object-fit:fill";
        if (cropped) media.style.clipPath = "inset(10px 20px 10px 40px)";
        stage.append(media);
        await new Promise((resolve, reject) => {
          media.onloadeddata = resolve;
          media.onerror = () =>
            reject(new Error(media.error?.message || "video decode failed"));
          media.src = "/crop-video.webm";
        });
        const selected = {
          element: media,
          id: media.id,
          selector: "#test-video",
          selectorIndex: 0,
          sourceFile: "index.html",
          tagName: "video",
          capabilities: {
            canApplyManualOffset: true,
            canApplyManualSize: true,
          },
        };
        opts = {
          overlayRef: ref(overlay),
          iframeRef: ref(frame),
          boxRef: ref(box),
          selectionRef: ref(selected),
          hoverSelectionRef: ref(null),
          overlayRectRef: ref(null),
          groupOverlayItemsRef: ref([]),
          gestureRef: ref(null),
          groupGestureRef: ref(null),
          blockedMoveRef: ref(null),
          rafPausedRef: ref(false),
          suppressNextBoxClickRef: ref(false),
          setOverlayRect: (r) => {
            opts.overlayRectRef.current = r;
          },
          setGroupOverlayItems: noop,
          onBlockedMoveRef: ref(() => {
            throw Error("gesture blocked");
          }),
          onManualDragStartRef: ref(noop),
          onPathOffsetCommitRef: ref(noop),
          onGroupPathOffsetCommitRef: ref(noop),
          onBoxSizeCommitRef: ref(noop),
          onRotationCommitRef: ref(noop),
          onCanvasPointerMoveRef: ref(noop),
          onCanvasMouseDown: noop,
          snapGuidesRef: ref(null),
        };
        handlers = createDomEditOverlayGestureHandlers(opts);
      },
      start(kind) {
        const rect = orientedOverlayRect(overlay, frame, media);
        const visible = hugOrientedRectForElement(rect, media);
        const x =
          kind === "resize"
            ? visible.left + visible.width
            : visible.left + visible.width / 2;
        const y =
          kind === "resize"
            ? visible.top + visible.height
            : visible.top + visible.height / 2;
        if (
          !handlers.startGesture(kind, event(x, y), {
            rect,
            interactionRect: visible,
          })
        )
          throw Error("start failed");
      },
      move(dx, dy) {
        const g = opts.gestureRef.current;
        handlers.onPointerMove(event(g.startX + dx, g.startY + dy));
      },
      async release(dx, dy) {
        const g = opts.gestureRef.current;
        handlers.onPointerUp(event(g.startX + dx, g.startY + dy));
        await new Promise(requestAnimationFrame);
      },
      clearCrop() {
        media.style.removeProperty("clip-path");
      },
      injectUnintendedCrop() {
        media.style.clipPath = "inset(0px 0px 0px 30px)";
      },
      geometry() {
        const source = orientedOverlayRect(overlay, frame, media);
        return {
          source,
          visible: hugOrientedRectForElement(source, media),
          crop: media.style.clipPath,
          border: {
            left: parseFloat(box.style.left),
            top: parseFloat(box.style.top),
            width: parseFloat(box.style.width),
            height: parseFloat(box.style.height),
          },
        };
      },
    };
  });
  const near = (a, b, label) =>
    assert(Math.abs(a - b) < 0.6, `${label}: expected ${b}, got ${a}`);
  // Decode Chromium's screenshot and inspect painted pixels, independently of
  // the geometry functions. Black is the canvas background; all media quadrants
  // have a saturated channel, including pixels close to every expected edge.
  async function pixels(expected, label) {
    const png = await page.screenshot({ encoding: "base64" });
    const bounds = await page.evaluate(async (png) => {
      const image = new Image();
      image.src = "data:image/png;base64," + png;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 240;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, 400, 240).data;
      let left = 400,
        top = 240,
        right = -1,
        bottom = -1,
        painted = 0;
      for (let y = 0; y < 240; y++)
        for (let x = 0; x < 400; x++) {
          const i = (y * 400 + x) * 4;
          if (Math.max(data[i], data[i + 1], data[i + 2]) > 100) {
            painted++;
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      return {
        left,
        top,
        width: right - left + 1,
        height: bottom - top + 1,
        painted,
      };
    }, png);
    for (const k of Object.keys(expected))
      near(bounds[k], expected[k], `${label} pixels ${k}`);
    assert.equal(
      bounds.painted,
      expected.width * expected.height,
      `${label}: no missing pixels inside visible media`,
    );
  }
  for (const cropped of [false, true]) {
    await page.evaluate((c) => window.cropTest.reset(c), cropped);
    const original = cropped
      ? { left: 140, top: 70, width: 100, height: 80 }
      : { left: 100, top: 60, width: 160, height: 100 };
    await pixels(original, "initial");
    await page.evaluate(() => {
      cropTest.start("drag");
      cropTest.move(210, 0);
    });
    await pixels(
      {
        ...original,
        left: original.left + 210,
        width: 400 - original.left - 210,
      },
      "canvas intersection",
    );
    await page.evaluate(() => cropTest.move(0, 0));
    await pixels(original, "drag back restores pixels");
    await page.evaluate(() => cropTest.release(0, 0));
    await page.evaluate(() => cropTest.start("resize"));
    const dx = original.width / 2,
      dy = original.height / 2;
    await page.evaluate(({ dx, dy }) => cropTest.move(dx, dy), { dx, dy });
    const expanded = {
      left: original.left - dx,
      top: original.top - dy,
      width: original.width * 2,
      height: original.height * 2,
    };
    await pixels(expanded, "resize");
    const draft = await page.evaluate(() => cropTest.geometry());
    for (const k of Object.keys(expanded)) {
      near(draft.visible[k], expanded[k], `visible ${k}`);
      near(draft.border[k], expanded[k], `border ${k}`);
    }
    near(draft.source.width, 320, "full source width");
    near(draft.source.height, 200, "full source height");
    await page.evaluate(({ dx, dy }) => cropTest.release(dx, dy), { dx, dy });
    await pixels(expanded, "release");
    assert.equal(
      (await page.evaluate(() => cropTest.geometry())).crop,
      draft.crop,
      "release must preserve authored crop",
    );
    if (cropped) {
      await page.evaluate(() => cropTest.clearCrop());
      await pixels(
        { left: 10, top: 10, width: 320, height: 200 },
        "reset crop restores hidden source",
      );
    }
    await page.evaluate((c) => cropTest.reset(c), cropped);
    await page.evaluate(() => cropTest.start("resize"));
    await page.evaluate(({ dx, dy }) => cropTest.move(dx * 3, dy * 3), {
      dx,
      dy,
    });
    const large = {
      left: original.left - dx * 3,
      top: original.top - dy * 3,
      width: original.width * 4,
      height: original.height * 4,
    };
    const intersection = {
      left: Math.max(0, large.left),
      top: Math.max(0, large.top),
      width: Math.min(400, large.left + large.width) - Math.max(0, large.left),
      height: Math.min(240, large.top + large.height) - Math.max(0, large.top),
    };
    await pixels(intersection, "oversized video clips only at canvas edges");
    const oversized = await page.evaluate(() => cropTest.geometry());
    near(oversized.source.width, 640, "oversized source width");
    near(oversized.source.height, 400, "oversized source height");
    await page.evaluate(({ dx, dy }) => cropTest.release(dx * 3, dy * 3), {
      dx,
      dy,
    });
    await page.evaluate(() => cropTest.start("resize"));
    await page.evaluate(({ dx, dy }) => cropTest.move(-dx * 3, -dy * 3), {
      dx,
      dy,
    });
    await page.evaluate(({ dx, dy }) => cropTest.release(-dx * 3, -dy * 3), {
      dx,
      dy,
    });
    await pixels(
      original,
      "shrinking oversized video restores original pixels",
    );
    console.log(
      `PASS ${cropped ? "cropped" : "uncropped"} video: move, canvas intersection, return, resize, border, release, oversize/shrink${cropped ? ", crop reset" : ""}`,
    );
  }
  await page.evaluate(() => cropTest.reset(false));
  await page.evaluate(() => cropTest.injectUnintendedCrop());
  await assert.rejects(
    () =>
      pixels(
        { left: 100, top: 60, width: 160, height: 100 },
        "deliberately broken crop",
      ),
    /deliberately broken crop pixels left/,
    "pixel regression must detect a video being unexpectedly chopped off",
  );
  console.log("PASS negative control: unintended source clipping is detected");
} finally {
  await browser?.close();
  await server?.close();
  await rm(scratch, { recursive: true, force: true });
}
