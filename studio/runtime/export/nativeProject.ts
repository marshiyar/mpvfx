import { resolveNativeDomBinding } from "../../shared/project/nativeDomBinding";
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
import { bakeTrackSamples, vkfEngine } from "../../shared/engine/vkfEngine";
import { sourceFrameValue } from "../../shared/project/nativeSourceTime";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "../../shared/project/nativeProjectDocument";

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
    !clip.sourceInFraction &&
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
  return resolveNativeDomBinding(selector => [...document.querySelectorAll(selector)], binding);
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
  const boundClips = project.sequence.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => normalizedSourceFile(clip.binding?.sourceFile ?? "") === normalizedFile);
  if (boundClips.length === 0) return html;

  const document = parseHTMLContent(html);
  for (const clip of boundClips) {
    const asset = assetsById.get(clip.assetId)!;
    const bindingTarget = nativeBindingTarget(document, clip);
    if (!bindingTarget) throw new Error(`Native export cannot resolve clip ${clip.id} in ${normalizedFile}`);
    bindingTarget.setAttribute("data-studio-clip-id", clip.id);
    if (asset.kind !== "audio" && asset.kind !== "video") continue;
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
    if (clip.muted) {
      if (asset.kind === "audio") media.setAttribute("data-hidden", "");
      else media.setAttribute("data-has-audio", "false");
      media.setAttribute("data-studio-native-export-muted", "");
      continue;
    }
    if (asset.kind !== "video" || !clip.audioGroupId || media.getAttribute("data-has-audio") !== "true") continue;
    const group = project.sequence.audioGroups?.find(candidate => candidate.id === clip.audioGroupId);
    const groupElements = [...document.querySelectorAll("hf-audio-group")]
      .filter(candidate => candidate.id === clip.audioGroupId);
    if (!group || groupElements.length !== 1) {
      throw new Error(`Native export cannot resolve audio group ${JSON.stringify(clip.audioGroupId)}`);
    }
    // Producer applies bus processing to <audio> members only. Keep the video
    // for picture, and route its sound through one export-only audio lane.
    media.setAttribute("data-has-audio", "false");
    if (group.muted) continue;
    const id = `__studio_export_audio_${Buffer.from(clip.id).toString("hex")}`;
    if (document.getElementById(id)) throw new Error(`Native export audio id is occupied: ${id}`);
    const audio = document.createElement("audio");
    audio.id = id;
    const source = media.getAttribute("src");
    if (source) audio.setAttribute("src", source);
    else for (const child of media.querySelectorAll("source")) audio.appendChild(child.cloneNode(true));
    const secondsPerFrame = project.frameRate.denominator / project.frameRate.numerator;
    const start = clip.startFrame * secondsPerFrame;
    audio.setAttribute("data-start", String(start));
    audio.setAttribute("data-end", String((clip.startFrame + clip.durationFrames) * secondsPerFrame));
    audio.setAttribute("data-media-start", String(sourceFrameValue(clip) * secondsPerFrame));
    audio.setAttribute("data-playback-rate", String(clip.playbackRate
      ? clip.playbackRate.numerator / clip.playbackRate.denominator : 1));
    audio.setAttribute("data-audio-group", group.id);
    audio.setAttribute("data-volume", String(clip.staticParameters?.["audio.volume"] ?? 1));
    if (clip.audioFxChain) audio.setAttribute("data-fx-chain", clip.audioFxChain);
    if (clip.audioAutomation) audio.setAttribute("data-automation", clip.audioAutomation);
    const groupElement = groupElements[0]!;
    groupElement.setAttribute("data-volume", String(group.volume ?? 1));
    if (group.fxChain) groupElement.setAttribute("data-fx-chain", group.fxChain);
    if (group.automation) groupElement.setAttribute("data-automation", group.automation);
    media.after(audio);
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
 * view receive canonical identities and static mixer exclusions.
 */
export function createNativeProjectExportMaterialization(
  projectDir: string,
  destinationDir: string,
  stagingRootDir: string,
  options: { renderBodyScripts?: readonly string[]; entryFile?: string; htmlOverrides?: ReadonlyMap<string, string>; sourceFiles?: ReadonlySet<string> } = {},
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
  const renderScripts = options.renderBodyScripts ?? [];
  if (!content.trim() && renderScripts.length === 0 && !options.htmlOverrides?.size) return sourceRoot;
  const project = content.trim() ? parseNativeProjectDocument(JSON.parse(content) as unknown) : null;
  const boundClips = (project?.sequence.tracks.flatMap((track) => track.clips) ?? []).filter(clip =>
    clip.binding && (!options.sourceFiles || options.sourceFiles.has(normalizedSourceFile(clip.binding.sourceFile))));
  for (const clip of boundClips) {
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
        `Native export cannot resolve compatibility source ${JSON.stringify(clip.binding.sourceFile)} for clip ${JSON.stringify(clip.id)}`,
      );
    }
  }
  if (boundClips.length === 0 && renderScripts.length === 0 && !options.htmlOverrides?.size) return sourceRoot;

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
      const ownsBinding = boundClips.some(
        (clip) => normalizedSourceFile(clip.binding!.sourceFile) === normalizedFile,
      );
      const injectScripts = renderScripts.length > 0 &&
        normalizedFile === normalizedSourceFile(options.entryFile ?? "index.html");
      const override = options.htmlOverrides?.get(normalizedFile);
      if (ownsBinding || injectScripts || override !== undefined) {
        let transformed = override ?? readFileSync(sourcePath, "utf8");
        if (ownsBinding && project) {
          transformed = applyNativeProjectExportAudioMutes(transformed, project, normalizedFile);
        }
        if (injectScripts) {
          const marked = parseHTMLContent(transformed);
          marked.documentElement?.setAttribute("data-studio-source-file", normalizedFile);
          transformed = marked.toString();
          // The installed producer does not consume a renderBodyScripts config
          // property. Materialize the scripts into its actual compilation input.
          const tags = renderScripts.map(script => `<script>${script.replace(/<\/script/gi, "<\\/script")}</script>`).join("\n");
          transformed = /<\/body\s*>/i.test(transformed)
            ? transformed.replace(/<\/body\s*>/i, () => `${tags}\n</body>`)
            : `${transformed}\n${tags}`;
        }
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

/**
 * The export page's native frame driver: the preview's own binding, frame
 * application and media transport code, bundled by
 * scripts/build/build-native-export-frame-runtime.mjs. The host sets
 * MPVFX_NATIVE_FRAME_RUNTIME to the bundle (see desktop/main.ts).
 */
let frameRuntimeCache: { path: string; source: string } | null = null;

function nativeExportFrameRuntimeSource(): string {
  const path = process.env.MPVFX_NATIVE_FRAME_RUNTIME;
  if (!path) throw new Error("MPVFX_NATIVE_FRAME_RUNTIME is not configured");
  if (frameRuntimeCache?.path !== path) {
    frameRuntimeCache = { path, source: readFileSync(path, "utf8") };
  }
  return frameRuntimeCache.source;
}

/**
 * Export pages cannot load the C++ engine, so every track is evaluated here
 * by the engine, for every frame the page can ask for, and shipped with the
 * project. The page then answers keyframe queries from these samples only.
 */
export function createNativeProjectRenderBodyScript(content: string): string | null {
  if (!content.trim()) return null;
  const project = parseNativeProjectDocument(JSON.parse(content) as unknown);
  const engine = vkfEngine();
  const baked = project.sequence.tracks.flatMap((track) => track.clips).map((clip) =>
    clip.parameterTracks.map((track) => bakeTrackSamples(engine, track, clip.durationFrames)));
  const bakedReferences = project.sequence.tracks.flatMap((track) => track.clips).map((clip) =>
    (clip.cropPivotSegments ?? []).map((segment) =>
      segment.reference?.parameterTracks.map((track) =>
        bakeTrackSamples(engine, track, segment.reference!.durationFrames)) ?? []));
  const input = { project, engineVersion: engine.version, baked, bakedReferences };
  return `${nativeExportFrameRuntimeSource()}
;(() => { window.__studioInstallNativeExportFrameRuntime(window, document, ${scriptSafeJson(input)}); })();`;
}
