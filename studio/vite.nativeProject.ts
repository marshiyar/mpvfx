import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { parseHTMLContent } from "@hyperframes/core/compiler";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "./src/project/nativeProjectDocument";

export function readNativeProjectDocumentContent(projectDir: string): string {
  const path = join(projectDir, NATIVE_PROJECT_DOCUMENT_PATH);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function isUntouchedSingleVideoProject(project: NativeProjectDocument): boolean {
  if (project.assets.length !== 1 || project.sequence.tracks.length !== 1) return false;
  const asset = project.assets[0]!;
  const track = project.sequence.tracks[0]!;
  if (asset.kind !== "video" || track.kind !== "video" || track.clips.length !== 1) {
    return false;
  }
  const clip = track.clips[0]!;
  const playbackRate = clip.playbackRate;
  return (
    project.canvas.background.toLowerCase() === "#000000" &&
    clip.assetId === asset.id &&
    clip.startFrame === 0 &&
    clip.durationFrames > 0 &&
    clip.sourceInFrame >= 0 &&
    clip.sourceInFrame + clip.durationFrames <= asset.durationFrames &&
    playbackRate?.numerator === 1 &&
    playbackRate.denominator === 1 &&
    !clip.muted &&
    Object.keys(clip.staticParameters ?? {}).length === 0 &&
    clip.effects.length === 0 &&
    clip.parameterTracks.length === 0
  );
}

/**
 * The browser-free exporter can safely represent exactly one untouched,
 * full-length native video. Every actual edit stays on the deterministic full
 * renderer; the direct exporter performs its own independent HTML/media probe.
 */
export function nativeProjectRequiresFullRenderer(projectDir: string): boolean {
  const content = readNativeProjectDocumentContent(projectDir);
  if (!content.trim()) return false;
  const project = parseNativeProjectDocument(JSON.parse(content) as unknown);
  return !isUntouchedSingleVideoProject(project);
}

function normalizedSourceFile(path: string): string {
  return posix.normalize(path.replace(/\\/g, "/")).replace(/^\.\//, "");
}

function isPathWithin(parentDir: string, childPath: string): boolean {
  const childRelative = relative(resolve(parentDir), resolve(childPath));
  return (
    childRelative === "" ||
    (!childRelative.startsWith("..") && !isAbsolute(childRelative))
  );
}

function nativeBindingTarget(document: Document, clip: NativeProjectDocument["sequence"]["tracks"][number]["clips"][number]): Element | null {
  const canonicalMatches: Element[] = [];
  for (const candidate of document.querySelectorAll("[data-studio-clip-id]")) {
    if (candidate.getAttribute("data-studio-clip-id") === clip.id) canonicalMatches.push(candidate);
  }
  if (canonicalMatches.length > 0) return canonicalMatches.length === 1 ? canonicalMatches[0]! : null;
  const binding = clip.binding;
  if (!binding) return null;
  const matches: Element[] = [];
  if (binding.domId) {
    const candidate = document.getElementById(binding.domId);
    if (!candidate) return null;
    matches.push(candidate);
  }
  if (binding.hfId) {
    const candidates = Array.from(document.querySelectorAll("[data-hf-id]")).filter(
      (candidate) => candidate.getAttribute("data-hf-id") === binding.hfId,
    );
    if (candidates.length !== 1) return null;
    matches.push(candidates[0]!);
  }
  if (binding.selector) {
    let candidates: Element[];
    try {
      candidates = Array.from(document.querySelectorAll(binding.selector));
    } catch {
      return null;
    }
    const candidate = typeof binding.selectorIndex === "number"
      ? candidates[binding.selectorIndex] ?? null
      : candidates.length === 1
        ? candidates[0]!
        : null;
    if (!candidate) return null;
    matches.push(candidate);
  }
  if (matches.length === 0 || matches.some((candidate) => candidate !== matches[0])) return null;
  return matches[0]!;
}

/**
 * Materialize native mute into Producer's static audio-discovery contract.
 * Audio elements can be excluded with data-hidden. A video's picture must
 * remain renderable, so only its data-has-audio lane is disabled.
 */
export function applyNativeProjectExportAudioMutes(
  html: string,
  project: NativeProjectDocument,
  sourceFile: string,
): string {
  const normalizedFile = normalizedSourceFile(sourceFile);
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const mutedClips = project.sequence.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => {
      const asset = assetsById.get(clip.assetId);
      return clip.muted && (asset?.kind === "audio" || asset?.kind === "video");
    })
    .filter((clip) => normalizedSourceFile(clip.binding?.sourceFile ?? "") === normalizedFile);
  if (mutedClips.length === 0) return html;

  const document = parseHTMLContent(html);
  for (const clip of mutedClips) {
    const asset = assetsById.get(clip.assetId)!;
    const bindingTarget = nativeBindingTarget(document, clip);
    const nestedMedia = bindingTarget
      ? Array.from(bindingTarget.querySelectorAll(asset.kind))
      : [];
    const media = bindingTarget?.tagName.toLowerCase() === asset.kind
      ? bindingTarget
      : nestedMedia.length === 1
        ? nestedMedia[0]!
        : null;
    if (!media) {
      throw new Error(
        `Native export cannot resolve muted ${asset.kind} clip ${JSON.stringify(clip.id)} in ${JSON.stringify(normalizedFile)}`,
      );
    }
    if (asset.kind === "audio") media.setAttribute("data-hidden", "");
    else media.setAttribute("data-has-audio", "false");
    media.setAttribute("data-studio-native-export-muted", "");
  }
  return document.toString();
}

function linkOrCopyFile(sourcePath: string, destinationPath: string): void {
  try {
    linkSync(sourcePath, destinationPath);
  } catch {
    copyFileSync(sourcePath, destinationPath);
  }
}

/**
 * Build a disposable, mostly hard-linked project view for offline rendering.
 * The authored project is never changed; only bound HTML files in the export
 * view receive static mixer exclusions.
 */
export function createNativeProjectExportMaterialization(
  projectDir: string,
  destinationDir: string,
  stagingRootDir: string,
): string {
  const sourceRoot = resolve(projectDir);
  const destinationRoot = resolve(destinationDir);
  const stagingRoot = resolve(stagingRootDir);
  if (sourceRoot === destinationRoot) {
    throw new Error("Native export materialization must not overwrite the source project");
  }
  if (
    !existsSync(stagingRoot) ||
    !lstatSync(stagingRoot).isDirectory() ||
    destinationRoot === stagingRoot ||
    !isPathWithin(stagingRoot, destinationRoot)
  ) {
    throw new Error("Native export materialization must be a strict child of its staging root");
  }
  const content = readNativeProjectDocumentContent(sourceRoot);
  if (!content.trim()) return sourceRoot;
  const project = parseNativeProjectDocument(JSON.parse(content) as unknown);
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const mutedMediaClips = project.sequence.tracks.flatMap((track) => track.clips).filter((clip) => {
    const kind = assetsById.get(clip.assetId)?.kind;
    return clip.muted && (kind === "audio" || kind === "video");
  });
  for (const clip of mutedMediaClips) {
    if (!clip.binding) {
      throw new Error(
        `Native export cannot guarantee mute for unbound clip ${JSON.stringify(clip.id)}`,
      );
    }
    const compatibilitySource = resolve(sourceRoot, clip.binding.sourceFile);
    if (
      !isPathWithin(sourceRoot, compatibilitySource) ||
      !existsSync(compatibilitySource) ||
      !lstatSync(compatibilitySource).isFile()
    ) {
      throw new Error(
        `Native export cannot resolve compatibility source ${JSON.stringify(clip.binding.sourceFile)} for muted clip ${JSON.stringify(clip.id)}`,
      );
    }
  }
  if (mutedMediaClips.length === 0) return sourceRoot;

  try {
    mkdirSync(destinationRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Native export materialization already exists: ${destinationRoot}`);
    }
    throw error;
  }
  const visit = (sourceDirectory: string): void => {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      const sourcePath = join(sourceDirectory, entry.name);
      if (isPathWithin(destinationRoot, sourcePath)) continue;
      const relativePath = relative(sourceRoot, sourcePath);
      const destinationPath = join(destinationRoot, relativePath);
      if (entry.isDirectory()) {
        mkdirSync(destinationPath, { recursive: true });
        visit(sourcePath);
        continue;
      }
      mkdirSync(dirname(destinationPath), { recursive: true });
      if (entry.isSymbolicLink()) {
        symlinkSync(readlinkSync(sourcePath), destinationPath);
        continue;
      }
      if (!lstatSync(sourcePath).isFile()) continue;
      const normalizedFile = normalizedSourceFile(relativePath);
      const ownsMutedBinding = mutedMediaClips.some(
        (clip) => normalizedSourceFile(clip.binding!.sourceFile) === normalizedFile,
      );
      if (ownsMutedBinding) {
        const transformed = applyNativeProjectExportAudioMutes(
          readFileSync(sourcePath, "utf8"),
          project,
          normalizedFile,
        );
        writeFileSync(destinationPath, transformed);
      } else {
        linkOrCopyFile(sourcePath, destinationPath);
      }
    }
  };
  visit(sourceRoot);
  return destinationRoot;
}

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function nativeRuntimeSource(project: NativeProjectDocument): string {
  const projectJson = scriptSafeJson(project);
  return `(() => {
  const project = ${projectJson};
  const clips = project.sequence.tracks.flatMap((track) => track.clips);
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const rate = project.frameRate;
  const number = (value) => {
    const rounded = Math.round(value * 1e12) / 1e12;
    return Object.is(rounded, -0) ? "0" : String(rounded);
  };
  const cubic = (time, first, second) => {
    const inverse = 1 - time;
    return 3 * inverse * inverse * time * first + 3 * inverse * time * time * second + time * time * time;
  };
  const derivative = (time, first, second) => {
    const inverse = 1 - time;
    return 3 * inverse * inverse * first + 6 * inverse * time * (second - first) + 3 * time * time * (1 - second);
  };
  const bezier = (progress, points) => {
    if (progress === 0 || progress === 1) return progress;
    let parameter = progress;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const difference = cubic(parameter, points.x1, points.x2) - progress;
      if (Math.abs(difference) < 1e-9) return cubic(parameter, points.y1, points.y2);
      const slope = derivative(parameter, points.x1, points.x2);
      if (Math.abs(slope) < 1e-7) break;
      const candidate = parameter - difference / slope;
      if (candidate < 0 || candidate > 1) break;
      parameter = candidate;
    }
    let lower = 0;
    let upper = 1;
    for (let iteration = 0; iteration < 30; iteration += 1) {
      parameter = (lower + upper) / 2;
      if (cubic(parameter, points.x1, points.x2) < progress) lower = parameter;
      else upper = parameter;
    }
    return cubic(parameter, points.y1, points.y2);
  };
  const mix = (left, right, progress) => left + (right - left) * progress;
  const evaluate = (track, frame) => {
    const keys = track.keyframes;
    if (frame <= keys[0].frame) return keys[0].value;
    if (frame >= keys[keys.length - 1].frame) return keys[keys.length - 1].value;
    let lower = 0;
    let upper = keys.length - 1;
    while (lower + 1 < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (keys[middle].frame <= frame) lower = middle;
      else upper = middle;
    }
    const start = keys[lower];
    const end = keys[upper];
    if (frame === start.frame) return start.value;
    if (frame === end.frame) return end.value;
    const raw = (frame - start.frame) / (end.frame - start.frame);
    const progress = start.outgoing.type === "hold" ? 0 : start.outgoing.type === "linear" ? raw : bezier(raw, start.outgoing.controlPoints);
    if (track.valueType === "number") return mix(start.value, end.value, progress);
    if (track.valueType === "vec2") return { x: mix(start.value.x, end.value.x, progress), y: mix(start.value.y, end.value.y, progress) };
    return {
      red: mix(start.value.red, end.value.red, progress),
      green: mix(start.value.green, end.value.green, progress),
      blue: mix(start.value.blue, end.value.blue, progress),
      alpha: mix(start.value.alpha, end.value.alpha, progress),
    };
  };
  const canonicalTarget = (clipId) => {
    const matches = [];
    for (const candidate of document.querySelectorAll("[data-studio-clip-id]")) {
      if (candidate.getAttribute("data-studio-clip-id") === clipId) matches.push(candidate);
    }
    return matches.length === 0
      ? { status: "missing", element: null }
      : matches.length === 1
        ? { status: "resolved", element: matches[0] }
        : { status: "ambiguous", element: null };
  };
  const uniqueAttributeTarget = (attribute, value) => {
    const matches = [];
    for (const candidate of document.querySelectorAll("[" + attribute + "]")) {
      if (candidate.getAttribute(attribute) === value) matches.push(candidate);
    }
    return matches.length === 1 ? matches[0] : null;
  };
  const selectorTarget = (selector, index) => {
    let matches;
    try { matches = Array.from(document.querySelectorAll(selector)); }
    catch { return null; }
    if (typeof index === "number") return matches[index] || null;
    return matches.length === 1 ? matches[0] : null;
  };
  const scopedTarget = (binding) => {
    if (!binding) return null;
    const matches = [];
    if (binding.domId) {
      const candidate = document.getElementById(binding.domId);
      if (!candidate) return null;
      matches.push(candidate);
    }
    if (binding.hfId) {
      const candidate = uniqueAttributeTarget("data-hf-id", binding.hfId);
      if (!candidate) return null;
      matches.push(candidate);
    }
    if (binding.selector) {
      const candidate = selectorTarget(binding.selector, binding.selectorIndex);
      if (!candidate) return null;
      matches.push(candidate);
    }
    if (matches.length === 0 || matches.some((candidate) => candidate !== matches[0])) return null;
    return matches[0];
  };
  const target = (clip) => {
    const canonical = canonicalTarget(clip.id);
    if (canonical.status === "ambiguous") return null;
    if (canonical.element) return canonical.element;
    const bound = scopedTarget(clip.binding);
    if (!bound) return null;
    // Canonical project identity is deliberately separate from legacy DOM ids.
    // Mark only the one exact binding that was resolved for this export document.
    if (!bound.hasAttribute("data-studio-clip-id")) bound.setAttribute("data-studio-clip-id", clip.id);
    return bound;
  };
  const mediaTarget = (clip, element) => {
    const asset = assetsById.get(clip.assetId);
    if (!asset || (asset.kind !== "video" && asset.kind !== "audio")) return null;
    if (element.tagName.toLowerCase() === asset.kind) return element;
    const matches = Array.from(element.querySelectorAll(asset.kind));
    return matches.length === 1 ? matches[0] : null;
  };
  const playbackRate = (clip) => clip.playbackRate.numerator / clip.playbackRate.denominator;
  const apply = (seconds) => {
    const projectFrame = Math.max(0, Math.floor((Math.max(0, Number(seconds) || 0) * rate.numerator) / rate.denominator + 1e-9));
    let applied = 0;
    for (const clip of clips) {
      const element = target(clip);
      if (!(element instanceof HTMLElement)) continue;
      applied += 1;
      const localFrame = projectFrame - clip.startFrame;
      const visible = localFrame >= 0 && localFrame < clip.durationFrames;
      element.style.visibility = visible ? "visible" : "hidden";
      const media = mediaTarget(clip, element);
      if (media) {
        const sourceRate = playbackRate(clip);
        media.playbackRate = sourceRate;
        // Hidden video is harmless, hidden audio is not. Muting every inactive
        // native clip prevents off-range audio leakage; authored mute is
        // restored deterministically on its first active export frame.
        media.muted = !visible || clip.muted;
        if (visible) {
          const sourceFrame = clip.sourceInFrame + localFrame * sourceRate;
          media.currentTime = (sourceFrame * rate.denominator) / rate.numerator;
        }
      }
      if (!visible) continue;
      const parameterOrder = [
        "transform.position", "transform.position.x", "transform.position.y", "transform.position.z", "transform.rotation",
        "transform.rotationX", "transform.rotationY", "transform.scale", "transform.scaleX", "transform.scaleY", "transform.scaleZ", "transform.perspective", "transform.opacity",
        "visual.opacity", "visual.autoAlpha", "layout.width", "layout.height"
      ];
      const values = new Map();
      // Static values form the deterministic base state. Track values are
      // applied afterward and therefore override only their matching base.
      for (const parameterId of parameterOrder) {
        if (clip.staticParameters && Object.prototype.hasOwnProperty.call(clip.staticParameters, parameterId)) {
          values.set(parameterId, clip.staticParameters[parameterId]);
        }
      }
      for (const track of clip.parameterTracks) {
        if (parameterOrder.includes(track.parameterId)) {
          values.set(track.parameterId, evaluate(track, localFrame));
        }
      }
      if (values.size === 0 && !element.hasAttribute("data-studio-native-owned")) continue;
      const previousOwned = new Set((element.getAttribute("data-studio-native-owned") || "").split(/\s+/).filter(Boolean));
      const transformIds = new Set([
        "transform.position", "transform.position.x", "transform.position.y", "transform.position.z", "transform.rotation",
        "transform.rotationX", "transform.rotationY", "transform.scale", "transform.scaleX", "transform.scaleY", "transform.scaleZ", "transform.perspective"
      ]);
      const opacityIds = new Set(["transform.opacity", "visual.opacity", "visual.autoAlpha"]);
      const positionValue = values.get("transform.position") || { x: 0, y: 0 };
      const position = {
        x: values.get("transform.position.x") ?? positionValue.x,
        y: values.get("transform.position.y") ?? positionValue.y,
      };
      const depth = values.get("transform.position.z") ?? 0;
      const rotation = values.get("transform.rotation") ?? 0;
      const rotationX = values.get("transform.rotationX") ?? 0;
      const rotationY = values.get("transform.rotationY") ?? 0;
      const scaleValue = values.get("transform.scale") ?? { x: 1, y: 1 };
      const baseScale = typeof scaleValue === "number" ? { x: scaleValue, y: scaleValue } : scaleValue;
      const scale = {
        x: values.get("transform.scaleX") ?? baseScale.x,
        y: values.get("transform.scaleY") ?? baseScale.y,
      };
      const scaleZ = values.get("transform.scaleZ") ?? 1;
      const perspective = Math.max(0, values.get("transform.perspective") ?? 0);
      const opacity = Math.max(0, Math.min(1,
        values.get("transform.opacity") ?? values.get("visual.opacity") ?? values.get("visual.autoAlpha") ?? 1
      ));
      const ownsTransform = parameterOrder.some((id) => transformIds.has(id) && values.has(id));
      const ownedTransformBefore = [...previousOwned].some((id) => transformIds.has(id));
      if (ownsTransform || ownedTransformBefore) {
        const owned3d = ["transform.position.z", "transform.rotationX", "transform.rotationY", "transform.scaleZ", "transform.perspective"].some((id) => values.has(id)) || ["transform.position.z", "transform.rotationX", "transform.rotationY", "transform.scaleZ", "transform.perspective"].some((id) => previousOwned.has(id));
        element.style.transform = owned3d
          ? (perspective > 0 ? "perspective(" + number(perspective) + "px) " : "") + "translate3d(" + number(position.x) + "px, " + number(position.y) + "px, " + number(depth) + "px) rotateX(" + number(rotationX) + "deg) rotateY(" + number(rotationY) + "deg) rotate(" + number(rotation) + "deg) scale3d(" + number(scale.x) + ", " + number(scale.y) + ", " + number(scaleZ) + ")"
          : "translate3d(" + number(position.x) + "px, " + number(position.y) + "px, 0px) rotate(" + number(rotation) + "deg) scale(" + number(scale.x) + ", " + number(scale.y) + ")";
      }
      const ownsOpacity = parameterOrder.some((id) => opacityIds.has(id) && values.has(id));
      const ownedOpacityBefore = [...previousOwned].some((id) => opacityIds.has(id));
      if (ownsOpacity || ownedOpacityBefore) element.style.opacity = number(opacity);
      if (values.has("layout.width")) element.style.width = number(Math.max(0, values.get("layout.width"))) + "px";
      else if (previousOwned.has("layout.width")) element.style.removeProperty("width");
      if (values.has("layout.height")) element.style.height = number(Math.max(0, values.get("layout.height"))) + "px";
      else if (previousOwned.has("layout.height")) element.style.removeProperty("height");
      element.setAttribute("data-studio-native-owned", parameterOrder.filter((id) => values.has(id)).join(" "));
    }
    return applied;
  };
  window.__studioNativeProject = project;
  window.__studioNativeProjectApply = apply;
  if (window.__studioNativeProjectSeekListener) {
    window.removeEventListener("hf-seek", window.__studioNativeProjectSeekListener);
  }
  const seekListener = (event) => apply(event && event.detail ? event.detail.time : 0);
  window.__studioNativeProjectSeekListener = seekListener;
  window.addEventListener("hf-seek", seekListener);
})();`;
}

export function createNativeProjectRenderBodyScript(content: string): string | null {
  if (!content.trim()) return null;
  const project = parseNativeProjectDocument(JSON.parse(content) as unknown);
  return nativeRuntimeSource(project);
}
