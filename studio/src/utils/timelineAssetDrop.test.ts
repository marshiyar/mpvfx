// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  buildTimelineFileDropPlacements,
  buildTimelineAssetInsertHtml,
  extendCompositionDurationIfNeeded,
  fitTimelineAssetGeometry,
  getTimelineAssetKind,
  insertTimelineAssetIntoSource,
  neutralizeCompositionRoot3dTransforms,
  resolveTimelineAssetCompositionSize,
  resolveTimelineAssetSrc,
  setCompositionDurationToContent,
} from "./timelineAssetDrop";

describe("composition-root 3D normalization for imported media", () => {
  const sourceWithScript = (script: string, rootStyle = "") => `<!doctype html><html><body>
    <div id="root" data-hf-id="hf-root" data-composition-id="main"${
      rootStyle ? ` style="${rootStyle}"` : ""
    }></div>
    <script>${script}</script>
  </body></html>`;

  it("neutralizes the persisted root tilt that would affect every imported video", () => {
    const source = sourceWithScript(`
      gsap.set("#root", {
        z: -224,
        transformPerspective: 1080,
        rotationX: 10,
        rotationY: -15,
        opacity: 0.8
      });
      gsap.set("#clip", { z: -50, rotationX: 12, rotationY: 7 });
    `);

    const normalized = neutralizeCompositionRoot3dTransforms(source);
    expect(normalized).toMatch(/gsap\.set\("#root",\s*\{[\s\S]*?z:\s*0/);
    expect(normalized).toMatch(/transformPerspective:\s*0/);
    expect(normalized).toMatch(/rotationX:\s*0/);
    expect(normalized).toMatch(/rotationY:\s*0/);
    expect(normalized).toContain("opacity: 0.8");
    expect(normalized).toContain('gsap.set("#clip", { z: -50, rotationX: 12, rotationY: 7 })');
  });

  it("handles timeline set/to/from/fromTo calls and quoted 3D property names", () => {
    const source = sourceWithScript(`
      window.__timelines["main"].set('#root', { 'rotationX': -6, rotationY: 19 }, 0);
      window.__timelines["main"].to("#root", { z: -269, transformPerspective: 1080, duration: 2 }, 1);
      gsap.from("#root", { rotationZ: 14, perspective: 700 });
      gsap.fromTo("#root", { rotationY: -20 }, { rotationY: 20, duration: 1 });
    `);
    const normalized = neutralizeCompositionRoot3dTransforms(source);

    expect(normalized).not.toMatch(
      /(?:rotationX|rotationY|rotationZ|\bz|transformPerspective|perspective)["']?\s*:\s*(?:-?[1-9]\d*)/,
    );
    expect(normalized).toContain("duration: 2");
    expect(normalized).toContain("duration: 1");
  });

  it("clears inline root 3D transforms while preserving unrelated root styles", () => {
    const source = sourceWithScript(
      "",
      "opacity: .7; transform: translateZ(-20px) rotateY(14deg); perspective: 900px; background: black",
    );
    const normalized = neutralizeCompositionRoot3dTransforms(source);
    const doc = new DOMParser().parseFromString(normalized, "text/html");
    const root = doc.querySelector<HTMLElement>("#root")!;

    expect(root.style.transform).toBe("");
    expect(root.style.perspective).toBe("");
    expect(root.style.opacity).toBe("0.7");
    expect(root.style.background).toBe("black");
  });

  it("is idempotent across repeated imports and inserts the video under a neutral canvas", () => {
    const source = sourceWithScript(
      'gsap.set("#root", { rotationX: 10, rotationY: -15, z: -224, transformPerspective: 1080 });',
    );
    const first = insertTimelineAssetIntoSource(source, '<video id="first"></video>');
    const second = insertTimelineAssetIntoSource(first, '<video id="second"></video>');

    expect(neutralizeCompositionRoot3dTransforms(second)).toBe(second);
    expect(second).toContain('<video id="first"></video>');
    expect(second).toContain('<video id="second"></video>');
    expect(second).not.toMatch(/rotationX:\s*10|rotationY:\s*-15|z:\s*-224|transformPerspective:\s*1080/);
  });

  it("leaves dynamic targets unchanged instead of rewriting an ambiguous animation", () => {
    const source = sourceWithScript(
      'const target = "#root"; gsap.set(target, { rotationY: 30, z: -100 });',
    );
    expect(neutralizeCompositionRoot3dTransforms(source)).toBe(source);
  });

  it("deduplicates nested root animation replacements without corrupting the script", () => {
    const source = sourceWithScript(`
      gsap.set("#root", {
        keyframes: [{ rotationY: 20 }, { rotationY: -20 }],
        onComplete: () => gsap.set("#root", { rotationX: 40 })
      });
    `);
    const normalized = neutralizeCompositionRoot3dTransforms(source);

    expect(normalized).toContain("keyframes: [{ rotationY: 0 }, { rotationY: 0 }]");
    expect(normalized).toContain('onComplete: () => gsap.set("#root", { rotationX: 0 })');
    expect(
      () => new Function(normalized.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ""),
    ).not.toThrow();
  });
});

describe("setCompositionDurationToContent", () => {
  const src = (dur: number) =>
    `<div id="root" data-composition-id="c" data-duration="${dur}">x</div>`;

  it("shrinks the root duration to the content end", () => {
    expect(setCompositionDurationToContent(src(20), 8)).toContain('data-duration="8"');
  });

  it("grows the root duration to the content end", () => {
    expect(setCompositionDurationToContent(src(5), 12)).toContain('data-duration="12"');
  });

  it("is a no-op when content end is 0 (empty timeline keeps its declared length)", () => {
    expect(setCompositionDurationToContent(src(12), 0)).toBe(src(12));
  });

  it("is a no-op when already equal", () => {
    expect(setCompositionDurationToContent(src(9), 9)).toBe(src(9));
  });

  // Reviewer round-2 finding #3: attribute-order and single-quote variants that
  // the old order-dependent, double-quotes-only regex silently ignored.
  it("patches when data-duration precedes data-composition-id", () => {
    const source = `<div data-duration="20" data-composition-id="c">x</div>`;
    expect(setCompositionDurationToContent(source, 8)).toBe(
      `<div data-duration="8" data-composition-id="c">x</div>`,
    );
  });

  it("patches single-quoted attributes and keeps the quote style", () => {
    const source = `<div data-composition-id='c' data-duration='20'>x</div>`;
    expect(setCompositionDurationToContent(source, 8)).toBe(
      `<div data-composition-id='c' data-duration='8'>x</div>`,
    );
  });
});

describe("extendCompositionDurationIfNeeded", () => {
  it("grows the root duration when a clip lands past the end", () => {
    const source = `<div data-composition-id="c" data-duration="5">x</div>`;
    expect(extendCompositionDurationIfNeeded(source, 8)).toBe(
      `<div data-composition-id="c" data-duration="8">x</div>`,
    );
  });

  it("is a no-op when the required end fits within the current duration", () => {
    const source = `<div data-composition-id="c" data-duration="10">x</div>`;
    expect(extendCompositionDurationIfNeeded(source, 8)).toBe(source);
  });

  it("grows even when the attribute order is swapped and quotes are single", () => {
    const source = `<div data-duration='5' data-composition-id='c'>x</div>`;
    expect(extendCompositionDurationIfNeeded(source, 8)).toBe(
      `<div data-duration='8' data-composition-id='c'>x</div>`,
    );
  });

  it("does not shorten an exact fractional-frame content end", () => {
    const source = `<div data-composition-id="c" data-duration="0.01">x</div>`;
    const exactFrameEnd = 1_001 / 30_000;
    const result = extendCompositionDurationIfNeeded(source, exactFrameEnd);
    const savedDuration = Number(result.match(/data-duration="([^"]+)"/)?.[1]);

    expect(savedDuration).toBeGreaterThanOrEqual(exactFrameEnd);
    expect(savedDuration).toBeCloseTo(exactFrameEnd, 12);
  });

  it("is a no-op when there is no composition root", () => {
    const source = `<div data-duration="5">x</div>`;
    expect(extendCompositionDurationIfNeeded(source, 8)).toBe(source);
  });
});

describe("getTimelineAssetKind", () => {
  it("detects image, video, and audio assets", () => {
    expect(getTimelineAssetKind("assets/photo.png")).toBe("image");
    expect(getTimelineAssetKind("assets/clip.mp4")).toBe("video");
    expect(getTimelineAssetKind("assets/clip.mov")).toBe("video");
    expect(getTimelineAssetKind("assets/music.mp3")).toBe("audio");
    expect(getTimelineAssetKind("assets/music.wav")).toBe("audio");
  });

  it("classifies svg as image", () => {
    expect(getTimelineAssetKind("assets/logo.svg")).toBe("image");
    expect(getTimelineAssetKind("assets/ICON.SVG")).toBe("image");
  });

  it("classifies avif and webp as image", () => {
    expect(getTimelineAssetKind("assets/photo.avif")).toBe("image");
    expect(getTimelineAssetKind("assets/photo.webp")).toBe("image");
  });

  it("returns null for unknown extensions", () => {
    expect(getTimelineAssetKind("assets/data.json")).toBeNull();
    expect(getTimelineAssetKind("assets/font.woff2")).toBeNull();
  });
});

describe("buildTimelineAssetInsertHtml", () => {
  it.each(["mp4", "m4v", "mov", "webm"])(
    "keeps newly inserted .%s video audio enabled by default",
    (extension) => {
      const assetPath = `assets/camera.${extension}`;
      const kind = getTimelineAssetKind(assetPath);
      expect(kind).toBe("video");

      const html = buildTimelineAssetInsertHtml({
        id: `camera_${extension}`,
        hfId: `hf-camera-${extension}`,
        assetPath,
        kind: "video",
        start: 0,
        duration: 5,
        track: 0,
        zIndex: 1,
      });
      const document = new DOMParser().parseFromString(html, "text/html");
      const video = document.querySelector("video");

      expect(video).not.toBeNull();
      expect(video?.hasAttribute("muted")).toBe(false);
      expect(video?.getAttribute("data-has-audio")).toBe("true");
      expect(video?.hasAttribute("playsinline")).toBe(true);
      expect(video?.hasAttribute("autoplay")).toBe(false);
    },
  );

  it("builds an image clip with explicit timing and track", () => {
    const html = buildTimelineAssetInsertHtml({
      id: "photo_asset",
      hfId: "hf-abc123",
      assetPath: "assets/photo.png",
      kind: "image",
      start: 1.25,
      duration: 3,
      track: 2,
      zIndex: 4,
      geometry: { left: 0, top: 0, width: 1280, height: 720 },
    });

    expect(html).toContain('img id="photo_asset"');
    expect(html).toContain("left: 0px");
    expect(html).toContain("width: 1280px");
    expect(html).not.toContain("inset:");
  });

  it("builds an audio clip without visual layout styles", () => {
    const html = buildTimelineAssetInsertHtml({
      id: "music_asset",
      hfId: "hf-xyz789",
      assetPath: "assets/music.wav",
      kind: "audio",
      start: 0.5,
      duration: 5,
      track: 0,
      zIndex: 1,
    });
    expect(html).toContain("<audio");
    expect(html).not.toContain("object-fit");
  });
});

describe("resolveTimelineAssetCompositionSize", () => {
  it("uses the target composition dimensions for visual media", () => {
    expect(
      resolveTimelineAssetCompositionSize(
        `<div data-composition-id="main" data-width="330" data-height="228"></div>`,
      ),
    ).toEqual({
      width: 330,
      height: 228,
    });
  });
});

describe("resolveTimelineAssetSrc", () => {
  it("keeps project-root asset paths for index.html", () => {
    expect(resolveTimelineAssetSrc("index.html", "assets/photo.png")).toBe("assets/photo.png");
  });

  it("rewrites asset paths relative to sub-compositions", () => {
    expect(resolveTimelineAssetSrc("compositions/scene-a.html", "assets/photo.png")).toBe(
      "../assets/photo.png",
    );
  });
});

describe("buildTimelineFileDropPlacements", () => {
  it("returns no placements for an empty drop set", () => {
    expect(buildTimelineFileDropPlacements({ start: 1.5, track: 2 }, [])).toEqual([]);
  });

  it("spaces multiple files by duration and keeps every one on the dropped track", () => {
    // A clip placed onto an occupied track stays there (overlap is allowed); it is
    // NOT bumped to a new track — that produced surprise empty tracks for users.
    expect(buildTimelineFileDropPlacements({ start: 1.5, track: 2 }, [1.2, 1.6, 1.1])).toEqual([
      { start: 1.5, track: 2 },
      { start: 2.7, track: 2 },
      { start: 4.3, track: 2 },
    ]);
  });

  it("uses fallback spacing when a duration is unavailable", () => {
    expect(buildTimelineFileDropPlacements({ start: 1.5, track: 2 }, [1.2, 0, 1.1])).toEqual([
      { start: 1.5, track: 2 },
      { start: 2.7, track: 2 },
      { start: 7.7, track: 2 },
    ]);
  });

  it("quantizes cumulative starts to exact project frames at fractional rates", () => {
    const frameRate = { numerator: 30_000, denominator: 1_001 } as const;
    const secondsAtFrame = (frame: number) =>
      (frame * frameRate.denominator) / frameRate.numerator;

    expect(
      buildTimelineFileDropPlacements(
        { start: secondsAtFrame(3), track: 4 },
        [secondsAtFrame(2), secondsAtFrame(3), secondsAtFrame(1)],
        frameRate,
      ),
    ).toEqual([
      { start: secondsAtFrame(3), track: 4 },
      { start: secondsAtFrame(5), track: 4 },
      { start: secondsAtFrame(8), track: 4 },
    ]);
  });

  it("accumulates quantized duration frames without introducing gaps", () => {
    const frameRate = { numerator: 30, denominator: 1 } as const;

    expect(
      buildTimelineFileDropPlacements(
        { start: 0, track: 2 },
        [1.02, 1.02, 1.02],
        frameRate,
      ),
    ).toEqual([
      { start: 0, track: 2 },
      { start: 1, track: 2 },
      { start: 2, track: 2 },
    ]);
  });
});

describe("insertTimelineAssetIntoSource", () => {
  it("appends the new asset inside the root composition", () => {
    const source = `<!doctype html><html><body><div id="root" data-composition-id="main"></div></body></html>`;
    const html = insertTimelineAssetIntoSource(
      source,
      '<img id="photo_asset" data-start="0" data-duration="3" />',
    );

    expect(html).toContain('data-composition-id="main">');
    expect(html).toContain('<img id="photo_asset" data-start="0" data-duration="3" />');
  });

  it("accepts a single-quoted composition root", () => {
    const source = `<div data-composition-id='main'></div>`;
    expect(insertTimelineAssetIntoSource(source, '<video id="clip"></video>')).toContain(
      '<video id="clip"></video>',
    );
  });

  it("explains how to recover when the composition root is missing", () => {
    expect(() => insertTimelineAssetIntoSource(`<html><body></body></html>`, "<video />")).toThrow(
      "Use Undo to restore it",
    );
  });
});

describe("buildTimelineAssetInsertHtml markup quality", () => {
  const base = {
    id: "clip_1",
    hfId: "hf-test-1",
    assetPath: "assets/a.mp4",
    start: 1,
    duration: 4,
    track: 2,
    zIndex: 3,
  };

  it("stamps data-hf-id on all kinds", () => {
    for (const kind of ["image", "video", "audio"] as const) {
      expect(buildTimelineAssetInsertHtml({ ...base, kind })).toContain('data-hf-id="hf-test-1"');
    }
  });

  it("audio gets an explicit data-volume", () => {
    expect(buildTimelineAssetInsertHtml({ ...base, kind: "audio" })).toContain('data-volume="1"');
  });
});

describe("fitTimelineAssetGeometry", () => {
  const comp = { width: 1920, height: 1080 };

  it("centers a smaller-than-comp asset at natural size", () => {
    expect(fitTimelineAssetGeometry({ width: 640, height: 360 }, comp)).toEqual({
      left: 640,
      top: 360,
      width: 640,
      height: 360,
    });
  });

  it("scales an oversized asset down to fit, preserving aspect, centered", () => {
    // 4000x1000 → capped to 1920 wide → 1920x480, centered vertically
    expect(fitTimelineAssetGeometry({ width: 4000, height: 1000 }, comp)).toEqual({
      left: 0,
      top: 300,
      width: 1920,
      height: 480,
    });
  });

  it("falls back to full-frame when natural size is unknown", () => {
    expect(fitTimelineAssetGeometry(null, comp)).toEqual({
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
    });
  });
});
