// @vitest-environment happy-dom

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAudioElements } from "@hyperframes/engine";

import { createNativeParameterTrack } from "./src/project/nativeKeyframeTypes";
import { applyNativeFrameToDocument } from "./src/project/nativeFrameApplication";
import { evaluateNativeParameterTrack } from "./src/project/nativeKeyframeEvaluator";
import {
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "./src/project/nativeProjectDocument";
import {
  applyNativeProjectExportAudioMutes,
  createNativeProjectExportMaterialization,
  createNativeProjectRenderBodyScript,
  nativeProjectRequiresFullRenderer,
  readNativeProjectDocumentContent,
} from "./vite.nativeProject";
import { createStudioDevRenderBodyScripts } from "./vite.studioMotion";

function projectDocument(): NativeProjectDocument {
  return {
    schemaVersion: 1 as const,
    id: "project:native",
    revision: 3,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [{ id: "asset:1", kind: "video" as const, name: "clip.mp4", durationFrames: 180 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [
        {
          id: "track:v1",
          kind: "video" as const,
          clips: [
            {
              id: "clip:1",
              assetId: "asset:1",
              startFrame: 30,
              durationFrames: 91,
              sourceInFrame: 0,
              muted: false,
              effects: [],
              parameterTracks: [
                createNativeParameterTrack({
                  id: "parameter:rotation",
                  parameterId: "transform.rotation",
                  valueType: "number",
                  frameRate: { numerator: 30, denominator: 1 },
                  keyframes: [
                    { id: "start", frame: 0, value: 0, outgoing: { type: "linear" } },
                    { id: "end", frame: 90, value: -180, outgoing: { type: "linear" } },
                  ],
                }),
                createNativeParameterTrack({
                  id: "parameter:opacity",
                  parameterId: "transform.opacity",
                  valueType: "number",
                  frameRate: { numerator: 30, denominator: 1 },
                  keyframes: [
                    { id: "opacity:start", frame: 0, value: 1, outgoing: { type: "linear" } },
                    { id: "opacity:end", frame: 90, value: 0.5, outgoing: { type: "linear" } },
                  ],
                }),
              ],
            },
          ],
        },
      ],
    },
  };
}

function untouchedVideoProjectDocument(): NativeProjectDocument {
  const project = projectDocument();
  const asset = project.assets[0]!;
  const clip = project.sequence.tracks[0]!.clips[0]!;
  clip.startFrame = 0;
  clip.durationFrames = asset.durationFrames;
  clip.sourceInFrame = 0;
  clip.playbackRate = { numerator: 1, denominator: 1 };
  clip.muted = false;
  clip.staticParameters = {};
  clip.effects = [];
  clip.parameterTracks = [];
  return project;
}

describe("native project render body script", () => {
  it("applies exact rational clip transport on every export seek", () => {
    const project = projectDocument();
    project.frameRate = { numerator: 30_000, denominator: 1_001 };
    project.assets[0] = {
      ...project.assets[0]!,
      durationFrames: 10_000,
    };
    const clip = project.sequence.tracks[0]!.clips[0]!;
    clip.startFrame = 10;
    clip.durationFrames = 3;
    clip.sourceInFrame = 100;
    clip.playbackRate = { numerator: 1_001, denominator: 1_000 };
    clip.parameterTracks = [];

    const media = document.createElement("video");
    media.setAttribute("data-studio-clip-id", clip.id);
    document.body.replaceChildren(media);
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(project))!);

    const secondsAtFrame = (frame: number) =>
      (frame * project.frameRate.denominator) / project.frameRate.numerator;

    window.dispatchEvent(new CustomEvent("hf-seek", {
      detail: { time: secondsAtFrame(9) },
    }));
    expect(media.style.visibility).toBe("hidden");
    expect(media.muted).toBe(true);

    window.dispatchEvent(new CustomEvent("hf-seek", {
      detail: { time: secondsAtFrame(11) },
    }));
    expect(media.style.visibility).toBe("visible");
    expect(media.playbackRate).toBeCloseTo(1.001, 12);
    expect(media.muted).toBe(false);
    expect(media.currentTime).toBeCloseTo(
      ((100 + 1.001) * 1_001) / 30_000,
      12,
    );

    // Export capture seeks are non-monotonic. Source time must be derived from
    // the requested frame rather than accumulated from the previous seek.
    window.dispatchEvent(new CustomEvent("hf-seek", {
      detail: { time: secondsAtFrame(10) },
    }));
    expect(media.currentTime).toBeCloseTo((100 * 1_001) / 30_000, 12);

    window.dispatchEvent(new CustomEvent("hf-seek", {
      detail: { time: secondsAtFrame(13) },
    }));
    expect(media.style.visibility).toBe("hidden");
    expect(media.muted).toBe(true);
  });

  it("uses native asset kind to control only the matching nested media element", () => {
    const project = projectDocument();
    project.assets = [
      { id: "asset:video", kind: "video", name: "picture.mp4", durationFrames: 300 },
      { id: "asset:audio", kind: "audio", name: "dialogue.wav", durationFrames: 300 },
      { id: "asset:image", kind: "image", name: "still.png", durationFrames: 300 },
    ];
    const baseClip = project.sequence.tracks[0]!.clips[0]!;
    project.sequence.tracks = [
      {
        id: "track:video",
        kind: "video",
        clips: [
          {
            ...baseClip,
            id: "clip:video",
            assetId: "asset:video",
            startFrame: 0,
            durationFrames: 30,
            sourceInFrame: 30,
            playbackRate: { numerator: 2, denominator: 1 },
            muted: false,
            parameterTracks: [],
          },
          {
            ...baseClip,
            id: "clip:image",
            assetId: "asset:image",
            startFrame: 0,
            durationFrames: 30,
            sourceInFrame: 0,
            playbackRate: { numerator: 1, denominator: 1 },
            muted: false,
            parameterTracks: [],
          },
        ],
      },
      {
        id: "track:audio",
        kind: "audio",
        clips: [{
          ...baseClip,
          id: "clip:audio",
          assetId: "asset:audio",
          startFrame: 0,
          durationFrames: 30,
          sourceInFrame: 60,
          playbackRate: { numerator: 1, denominator: 2 },
          muted: true,
          parameterTracks: [],
        }],
      },
    ];

    const videoRoot = document.createElement("div");
    videoRoot.setAttribute("data-studio-clip-id", "clip:video");
    const video = document.createElement("video");
    const unrelatedAudio = document.createElement("audio");
    unrelatedAudio.currentTime = 7;
    videoRoot.append(video, unrelatedAudio);

    const audioRoot = document.createElement("div");
    audioRoot.setAttribute("data-studio-clip-id", "clip:audio");
    const unrelatedVideo = document.createElement("video");
    unrelatedVideo.currentTime = 8;
    const audio = document.createElement("audio");
    audioRoot.append(unrelatedVideo, audio);

    const image = document.createElement("img");
    image.setAttribute("data-studio-clip-id", "clip:image");
    document.body.replaceChildren(videoRoot, audioRoot, image);
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(project))!);
    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 10 / 30 } }));

    expect(video.playbackRate).toBe(2);
    expect(video.currentTime).toBeCloseTo(50 / 30, 12);
    expect(video.muted).toBe(false);
    expect(unrelatedAudio.currentTime).toBe(7);
    expect(audio.playbackRate).toBe(0.5);
    expect(audio.currentTime).toBeCloseTo(65 / 30, 12);
    expect(audio.muted).toBe(true);
    expect(unrelatedVideo.currentTime).toBe(8);
    expect(image.style.visibility).toBe("visible");
  });

  it("restores an authored unmuted clip on re-entry after inactive export frames", () => {
    const project = projectDocument();
    const clip = project.sequence.tracks[0]!.clips[0]!;
    clip.startFrame = 5;
    clip.durationFrames = 5;
    clip.sourceInFrame = 10;
    clip.playbackRate = { numerator: 1, denominator: 1 };
    clip.muted = false;
    clip.parameterTracks = [];
    const media = document.createElement("video");
    media.setAttribute("data-studio-clip-id", clip.id);
    document.body.replaceChildren(media);
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(project))!);

    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 0 } }));
    expect(media.muted).toBe(true);
    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 5 / 30 } }));
    expect(media.muted).toBe(false);
    expect(media.currentTime).toBeCloseTo(10 / 30, 12);
  });

  it("is self-contained, local-only, and renders the same midpoint as the shared evaluator", () => {
    const project = projectDocument();
    const content = serializeNativeProjectDocument(project);
    const script = createNativeProjectRenderBodyScript(content);
    expect(script).not.toBeNull();
    expect(script).toContain("__studioNativeProjectApply");
    expect(script).not.toMatch(/\b(?:fetch|import)\s*\(/);
    expect(script).not.toMatch(/\bgsap\b/i);

    const element = document.createElement("div");
    element.setAttribute("data-studio-clip-id", "clip:1");
    document.body.replaceChildren(element);
    window.eval(script!);
    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 2.5 } }));

    const rotation = project.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!;
    expect(evaluateNativeParameterTrack(rotation, 45)).toBe(-90);
    expect(element.style.transform).toContain("rotate(-90deg)");
    expect(element.style.opacity).toBe("0.75");
  });

  it("repeated and non-monotonic export seeks produce byte-identical style output", () => {
    const project = projectDocument();
    project.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      domId: "clip:1",
    };
    const script = createNativeProjectRenderBodyScript(
      serializeNativeProjectDocument(project),
    )!;
    const element = document.createElement("div");
    element.id = "clip:1";
    document.body.replaceChildren(element);
    window.eval(script);

    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 2.5 } }));
    const first = element.getAttribute("style");
    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 1.1 } }));
    expect(element.getAttribute("style")).not.toBe(first);
    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 2.5 } }));
    expect(element.getAttribute("style")).toBe(first);
  });

  it("uses strict scoped bindings in export, without treating canonical clip ids as DOM ids", () => {
    const hf = document.createElement("div");
    hf.setAttribute("data-hf-id", "hf:camera");
    const first = document.createElement("div");
    const second = document.createElement("div");
    first.className = "legacy-clip";
    second.className = "legacy-clip";
    const canonical = document.createElement("div");
    canonical.setAttribute("data-studio-clip-id", "clip:1");
    document.body.replaceChildren(hf, first, second, canonical);

    const project = projectDocument();
    project.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      hfId: "hf:camera",
    };
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(project))!);
    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 2.5 } }));

    // Existing native identity wins over a conflicting bridge target.
    expect(canonical.style.transform).toContain("rotate(-90deg)");
    expect(hf.getAttribute("data-studio-clip-id")).toBeNull();

    canonical.removeAttribute("data-studio-clip-id");
    const indexed = projectDocument();
    indexed.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      selector: ".legacy-clip",
      selectorIndex: 1,
    };
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(indexed))!);
    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 2.5 } }));
    expect(first.getAttribute("data-studio-clip-id")).toBeNull();
    expect(second.getAttribute("data-studio-clip-id")).toBe("clip:1");

    second.removeAttribute("data-studio-clip-id");
    const ambiguous = projectDocument();
    ambiguous.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      selector: ".legacy-clip",
    };
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(ambiguous))!);
    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 2.5 } }));
    expect(first.getAttribute("data-studio-clip-id")).toBeNull();
    expect(second.getAttribute("data-studio-clip-id")).toBeNull();

    const duplicateA = document.createElement("div");
    const duplicateB = document.createElement("div");
    duplicateA.setAttribute("data-studio-clip-id", "clip:1");
    duplicateB.setAttribute("data-studio-clip-id", "clip:1");
    hf.removeAttribute("style");
    document.body.replaceChildren(duplicateA, duplicateB, hf);
    const duplicateCanonical = projectDocument();
    duplicateCanonical.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      hfId: "hf:camera",
    };
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(duplicateCanonical))!);
    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 2.5 } }));
    expect(duplicateA.getAttribute("style")).toBeNull();
    expect(duplicateB.getAttribute("style")).toBeNull();
    expect(hf.getAttribute("style")).toBeNull();
  });

  it("renders scalar compatibility channels with the same transform as preview", () => {
    const project = projectDocument();
    const scalar = (id: string, parameterId: string, from: number, to: number) =>
      createNativeParameterTrack({
        id,
        parameterId,
        valueType: "number" as const,
        frameRate: project.frameRate,
        keyframes: [
          { id: `${id}:start`, frame: 0, value: from, outgoing: { type: "linear" as const } },
          { id: `${id}:end`, frame: 90, value: to, outgoing: { type: "linear" as const } },
        ],
      });
    project.sequence.tracks[0]!.clips[0]!.parameterTracks = [
      scalar("x", "transform.position.x", 0, 100),
      scalar("y", "transform.position.y", 10, 40),
      scalar("rotation", "transform.rotation", 0, -180),
      scalar("scale-x", "transform.scaleX", 1, 2),
      scalar("scale-y", "transform.scaleY", 1, 1.5),
      scalar("opacity", "visual.opacity", 1, 0.5),
    ];
    const element = document.createElement("div");
    element.setAttribute("data-studio-clip-id", "clip:1");
    document.body.replaceChildren(element);
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(project))!);

    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 2.5 } }));

    expect(element.style.transform).toBe(
      "translate3d(50px, 25px, 0px) rotate(-90deg) scale(1.5, 1.25)",
    );
    expect(element.style.opacity).toBe("0.75");
  });

  it("keeps native 3D transform output identical between preview and export", () => {
    const project = projectDocument();
    const scalar = (id: string, parameterId: string, from: number, to: number) =>
      createNativeParameterTrack({
        id,
        parameterId,
        valueType: "number" as const,
        frameRate: project.frameRate,
        keyframes: [
          { id: `${id}:start`, frame: 0, value: from, outgoing: { type: "linear" as const } },
          { id: `${id}:end`, frame: 90, value: to, outgoing: { type: "linear" as const } },
        ],
      });
    const clip = project.sequence.tracks[0]!.clips[0]!;
    clip.parameterTracks = [
      scalar("z", "transform.position.z", 0, 120),
      scalar("rx", "transform.rotationX", 12, 12),
      scalar("ry", "transform.rotationY", -18, -18),
      scalar("sz", "transform.scaleZ", 0.8, 0.8),
      scalar("perspective", "transform.perspective", 900, 900),
    ];
    const previewElement = document.createElement("div");
    previewElement.setAttribute("data-studio-clip-id", "clip:1");
    const exportElement = document.createElement("div");
    exportElement.id = "clip:1";
    document.body.replaceChildren(previewElement, exportElement);

    applyNativeFrameToDocument(document, [{
      clipId: clip.id,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
      parameterTracks: clip.parameterTracks,
    }], 75);
    const previewStyle = previewElement.getAttribute("style");
    previewElement.removeAttribute("data-studio-clip-id");
    clip.binding = { sourceFile: "index.html", domId: "clip:1" };
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(project))!);
    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 2.5 } }));

    expect(exportElement.getAttribute("style")).toBe(previewStyle);
  });

  it("renders native width and height tracks without overwriting legacy picture channels", () => {
    const project = projectDocument();
    const scalar = (id: string, parameterId: string, from: number, to: number) =>
      createNativeParameterTrack({
        id,
        parameterId,
        valueType: "number" as const,
        frameRate: project.frameRate,
        keyframes: [
          { id: `${id}:start`, frame: 0, value: from, outgoing: { type: "linear" as const } },
          { id: `${id}:end`, frame: 90, value: to, outgoing: { type: "linear" as const } },
        ],
      });
    project.sequence.tracks[0]!.clips[0]!.parameterTracks = [
      scalar("width", "layout.width", 640, 1280),
      scalar("height", "layout.height", 360, 720),
    ];
    const element = document.createElement("div");
    element.setAttribute("data-studio-clip-id", "clip:1");
    element.style.transform = "translateX(12px)";
    element.style.opacity = "0.6";
    document.body.replaceChildren(element);
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(project))!);

    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 2.5 } }));

    expect(element.style.width).toBe("960px");
    expect(element.style.height).toBe("540px");
    expect(element.style.transform).toBe("translateX(12px)");
    expect(element.style.opacity).toBe("0.6");
  });

  it("does not let a structural native clip overwrite legacy-owned picture properties", () => {
    const project = projectDocument();
    project.sequence.tracks[0]!.clips[0]!.parameterTracks = [];
    const element = document.createElement("div");
    element.id = "clip:1";
    element.style.transform = "translateX(12px) rotate(20deg)";
    element.style.opacity = "0.6";
    document.body.replaceChildren(element);
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(project))!);

    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 2.5 } }));

    expect(element.style.transform).toBe("translateX(12px) rotate(20deg)");
    expect(element.style.opacity).toBe("0.6");
  });

  it("keeps preview and export output identical for static bases and animated overrides", () => {
    const project = projectDocument();
    const clip = project.sequence.tracks[0]!.clips[0]!;
    clip.staticParameters = {
      "transform.position": { x: 24, y: -12 },
      "transform.rotation": 45,
      "transform.scale": { x: 1.25, y: 0.75 },
      "transform.opacity": 0.65,
      "layout.width": 1280,
      "layout.height": 720,
    };
    clip.parameterTracks = clip.parameterTracks.filter(
      (track) => track.parameterId === "transform.rotation",
    );
    const previewElement = document.createElement("div");
    previewElement.setAttribute("data-studio-clip-id", "clip:1");
    const exportElement = document.createElement("div");
    exportElement.setAttribute("data-studio-clip-id", "clip:1");
    document.body.replaceChildren(previewElement, exportElement);

    applyNativeFrameToDocument(
      document,
      [{
        clipId: clip.id,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        staticParameters: clip.staticParameters,
        parameterTracks: clip.parameterTracks,
      }],
      75,
    );
    const previewStyle = previewElement.getAttribute("style");
    expect(previewStyle).toContain(
      "translate3d(24px, -12px, 0px) rotate(-90deg) scale(1.25, 0.75)",
    );
    expect(previewStyle).toContain("opacity: 0.65");
    expect(previewStyle).toContain("width: 1280px");
    expect(previewStyle).toContain("height: 720px");

    // Run the exact export body script against a fresh target at the same frame.
    previewElement.removeAttribute("data-studio-clip-id");
    exportElement.removeAttribute("data-studio-clip-id");
    exportElement.id = "clip:1";
    clip.binding = { sourceFile: "index.html", domId: "clip:1" };
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(project))!);
    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: 2.5 } }));

    expect(exportElement.getAttribute("style")).toBe(previewStyle);
  });

  it("rejects malformed sidecar data instead of injecting a partial animation", () => {
    expect(() => createNativeProjectRenderBodyScript('{"schemaVersion":1}')).toThrow();
    expect(createNativeProjectRenderBodyScript("")).toBeNull();
  });
});

describe("native export integration", () => {
  let projectDir: string | null = null;

  afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    projectDir = null;
  });

  function writeProject(content = serializeNativeProjectDocument(projectDocument())): string {
    projectDir = mkdtempSync(join(tmpdir(), "studio-native-project-"));
    mkdirSync(join(projectDir, ".studio"), { recursive: true });
    writeFileSync(join(projectDir, ".studio/project.json"), content);
    return projectDir;
  }

  it("reads only the project-owned native sidecar and requires the full renderer when present", () => {
    const dir = writeProject();
    expect(readNativeProjectDocumentContent(dir)).toContain('"project:native"');
    expect(nativeProjectRequiresFullRenderer(dir)).toBe(true);
  });

  it("allows one untouched native video clip to attempt direct export", () => {
    const project = untouchedVideoProjectDocument();
    const dir = writeProject(serializeNativeProjectDocument(project));

    expect(nativeProjectRequiresFullRenderer(dir)).toBe(false);
  });

  it.each([
    ["end-trimmed", 0],
    ["source-trimmed", 1],
  ] as const)("allows one %s native video clip to attempt direct export", (_label, sourceInFrame) => {
    const project = untouchedVideoProjectDocument();
    const clip = project.sequence.tracks[0]!.clips[0]!;
    clip.sourceInFrame = sourceInFrame;
    clip.durationFrames -= 1;
    const dir = writeProject(serializeNativeProjectDocument(project));

    expect(nativeProjectRequiresFullRenderer(dir)).toBe(false);
  });

  it.each([
    ["timeline offset", (project: NativeProjectDocument) => { project.sequence.tracks[0]!.clips[0]!.startFrame = 1; }],
    ["speed change", (project: NativeProjectDocument) => {
      project.sequence.tracks[0]!.clips[0]!.durationFrames /= 2;
      project.sequence.tracks[0]!.clips[0]!.playbackRate = { numerator: 2, denominator: 1 };
    }],
    ["mute", (project: NativeProjectDocument) => { project.sequence.tracks[0]!.clips[0]!.muted = true; }],
    ["canvas background change", (project: NativeProjectDocument) => { project.canvas.background = "#ff0000"; }],
    ["static picture change", (project: NativeProjectDocument) => { project.sequence.tracks[0]!.clips[0]!.staticParameters = { "transform.rotation": 10 }; }],
    ["effect", (project: NativeProjectDocument) => { project.sequence.tracks[0]!.clips[0]!.effects = [{ id: "fx:1", effectId: "blur", enabled: true }]; }],
    ["keyframe", (project: NativeProjectDocument) => {
      project.sequence.tracks[0]!.clips[0]!.parameterTracks = [createNativeParameterTrack({
        id: "parameter:rotation",
        parameterId: "transform.rotation",
        valueType: "number",
        frameRate: project.frameRate,
        keyframes: [{ id: "rotation:start", frame: 0, value: 10, outgoing: { type: "hold" } }],
      })];
    }],
    ["extra clip", (project: NativeProjectDocument) => { project.sequence.tracks[0]!.clips.push({ ...project.sequence.tracks[0]!.clips[0]!, id: "clip:2" }); }],
  ] as const)("keeps a native project with a %s on the full renderer", (_label, edit) => {
    const project = untouchedVideoProjectDocument();
    edit(project);
    const dir = writeProject(serializeNativeProjectDocument(project));

    expect(nativeProjectRequiresFullRenderer(dir)).toBe(true);
  });

  it("injects native evaluation after legacy compatibility scripts so native-owned properties win", () => {
    const dir = writeProject();
    const scripts = createStudioDevRenderBodyScripts(dir);

    expect(scripts.at(-1)).toContain("__studioNativeProjectApply");
  });

  it("does not disable direct export for a project with no native sidecar", () => {
    projectDir = mkdtempSync(join(tmpdir(), "studio-legacy-project-"));
    expect(readNativeProjectDocumentContent(projectDir)).toBe("");
    expect(nativeProjectRequiresFullRenderer(projectDir)).toBe(false);
  });

  it("materializes native mute into the offline mixer contract without hiding video", () => {
    const project = projectDocument();
    project.assets = [
      { id: "asset:video", kind: "video", name: "picture.mp4", durationFrames: 180 },
      { id: "asset:audio", kind: "audio", name: "dialogue.wav", durationFrames: 180 },
      { id: "asset:music", kind: "audio", name: "music.wav", durationFrames: 180 },
    ];
    const base = project.sequence.tracks[0]!.clips[0]!;
    project.sequence.tracks = [
      {
        id: "track:video",
        kind: "video",
        clips: [{
          ...base,
          id: "clip:video",
          assetId: "asset:video",
          binding: { sourceFile: "index.html", domId: "picture" },
          muted: true,
          parameterTracks: [],
        }],
      },
      {
        id: "track:audio",
        kind: "audio",
        clips: [
          {
            ...base,
            id: "clip:dialogue",
            assetId: "asset:audio",
            binding: { sourceFile: "index.html", hfId: "dialogue" },
            muted: true,
            parameterTracks: [],
          },
          {
            ...base,
            id: "clip:music",
            assetId: "asset:music",
            binding: { sourceFile: "index.html", selector: ".music", selectorIndex: 0 },
            muted: false,
            parameterTracks: [],
          },
        ],
      },
    ];
    const sourceDir = writeProject(serializeNativeProjectDocument(project));
    writeFileSync(join(sourceDir, "picture.mp4"), "picture");
    writeFileSync(join(sourceDir, "dialogue.wav"), "dialogue");
    writeFileSync(join(sourceDir, "music.wav"), "music");
    const sourceHtml = `<!doctype html><html><body>
      <video id="picture" src="picture.mp4" data-has-audio="true"></video>
      <audio id="dialogue" data-hf-id="dialogue" src="dialogue.wav"></audio>
      <audio id="music" class="music" src="music.wav"></audio>
    </body></html>`;
    writeFileSync(join(sourceDir, "index.html"), sourceHtml);
    const stagingRoot = join(sourceDir, ".studio");
    const exportDir = join(stagingRoot, "export-view");

    const materialized = createNativeProjectExportMaterialization(
      sourceDir,
      exportDir,
      stagingRoot,
    );
    const exported = readFileSync(join(materialized, "index.html"), "utf8");
    const exportedDocument = new DOMParser().parseFromString(exported, "text/html");
    const video = exportedDocument.querySelector<HTMLVideoElement>("#picture")!;
    const dialogue = exportedDocument.querySelector<HTMLAudioElement>('[data-hf-id="dialogue"]')!;
    const music = exportedDocument.querySelector<HTMLAudioElement>(".music")!;

    expect(video.getAttribute("data-has-audio")).toBe("false");
    expect(video.hasAttribute("data-hidden")).toBe(false);
    expect(dialogue.hasAttribute("data-hidden")).toBe(true);
    expect(music.hasAttribute("data-hidden")).toBe(false);
    expect(parseAudioElements(exported).map((element) => element.id)).toEqual(["music"]);
    expect(readFileSync(join(sourceDir, "index.html"), "utf8")).toBe(sourceHtml);
    expect(applyNativeProjectExportAudioMutes(exported, project, "index.html")).toBe(exported);

    const occupiedDir = join(sourceDir, ".studio", "occupied-export-view");
    mkdirSync(occupiedDir);
    writeFileSync(join(occupiedDir, "keep.txt"), "keep");
    expect(() => createNativeProjectExportMaterialization(sourceDir, occupiedDir, stagingRoot)).toThrow(
      /already exists/i,
    );
    expect(readFileSync(join(occupiedDir, "keep.txt"), "utf8")).toBe("keep");
    expect(() => createNativeProjectExportMaterialization(sourceDir, stagingRoot, stagingRoot))
      .toThrow(/strict child/i);

    project.sequence.tracks[1]!.clips[0]!.binding = {
      sourceFile: "nested/../index.html",
      domId: "dialogue",
    };
    writeFileSync(
      join(sourceDir, ".studio/project.json"),
      serializeNativeProjectDocument(project),
    );
    const normalizedExportDir = join(sourceDir, ".studio", "normalized-export-view");
    createNativeProjectExportMaterialization(sourceDir, normalizedExportDir, stagingRoot);
    expect(
      parseAudioElements(readFileSync(join(normalizedExportDir, "index.html"), "utf8"))
        .map((element) => element.id),
    ).toEqual(["music"]);

    const ambiguousHtml = sourceHtml.replace(
      "<body>",
      '<body><span data-studio-clip-id="clip:dialogue"><audio src="wrong.wav"></audio></span><span data-studio-clip-id="clip:dialogue"><audio src="also-wrong.wav"></audio></span>',
    );
    expect(() => applyNativeProjectExportAudioMutes(ambiguousHtml, project, "index.html")).toThrow(
      /cannot resolve muted audio clip/i,
    );
    project.sequence.tracks[1]!.clips[0]!.binding = {
      sourceFile: "index.html",
      domId: "audio-wrapper",
    };
    const duplicateNestedMedia = sourceHtml.replace(
      '<audio id="dialogue" data-hf-id="dialogue" src="dialogue.wav"></audio>',
      '<div id="audio-wrapper"><audio src="one.wav"></audio><audio src="two.wav"></audio></div>',
    );
    expect(() => applyNativeProjectExportAudioMutes(duplicateNestedMedia, project, "index.html"))
      .toThrow(/cannot resolve muted audio clip/i);

    project.sequence.tracks[1]!.clips[0]!.binding = {
      sourceFile: "missing.html",
      domId: "dialogue",
    };
    writeFileSync(
      join(sourceDir, ".studio/project.json"),
      serializeNativeProjectDocument(project),
    );
    expect(() => createNativeProjectExportMaterialization(sourceDir, exportDir, stagingRoot)).toThrow(
      /cannot resolve compatibility source/i,
    );
  });
});
