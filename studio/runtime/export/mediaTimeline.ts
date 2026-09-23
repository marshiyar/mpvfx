import { parseHTMLContent } from "@hyperframes/core/compiler";
import { parseNativeProjectDocument, type NativeProjectDocument } from "../../shared/project/nativeProjectDocument";
import { nativeMediaSource } from "../../shared/project/nativeMediaSource";
import { hasOnlyBoilerplateScripts, hasOnlyBoilerplateStyles } from "./directMediaExport";
import { assertNativeTimelineSupported } from "../media/timelineRenderer";

function mediaGeometry(element: Element): Record<string, number> | null {
  const declarations = new Map<string, string>();
  for (const declaration of (element.getAttribute("style") ?? "").split(";")) {
    if (!declaration.trim()) continue;
    const [property, value, extra] = declaration.split(":").map(part => part.trim());
    if (!property || !value || extra || declarations.has(property)) return null;
    declarations.set(property, value);
  }
  const allowed = new Set(["position", "left", "top", "width", "height", "object-fit", "z-index"]);
  if ([...declarations.keys()].some(key => !allowed.has(key))) return null;
  if (element.tagName.toLowerCase() !== "audio" && (declarations.get("position") !== "absolute" || declarations.get("object-fit") !== "contain")) return null;
  const result: Record<string, number> = {};
  for (const [css, parameter] of [["left", "layout.left"], ["top", "layout.top"], ["width", "layout.width"], ["height", "layout.height"], ["z-index", "layout.zIndex"]]) {
    const raw = declarations.get(css);
    if (raw === undefined) {
      if (element.tagName.toLowerCase() !== "audio") return null;
      continue;
    }
    if (!/^-?\d+(?:\.\d+)?(?:px)?$/.test(raw)) return null;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value) || ((css === "width" || css === "height") && value <= 0)) return null;
    result[parameter] = value;
  }
  return result;
}

/**
 * Migration boundary for simple legacy media projects. Markup is inspected only
 * to establish that no unrepresented picture/effect would be lost. Rendering
 * receives a detached media document; it never receives markup or DOM bindings.
 */
export function mediaTimelineForExport(project: NativeProjectDocument, legacySource?: string | null): NativeProjectDocument | null {
  const clips = project.sequence.tracks.flatMap(track => track.clips);
  if (project.mediaEngine === "ffmpeg") {
    assertNativeTimelineSupported(project);
    return project;
  }
  if (!legacySource || !clips.length) return null;
  const document = parseHTMLContent(legacySource);
  const roots = [...document.querySelectorAll("[data-composition-id]")];
  if (roots.length !== 1) return null;
  const root = roots[0]!;
  const compositionId = root.getAttribute("data-composition-id");
  if (!compositionId || root.parentElement !== document.body || document.querySelector("base, [data-composition-src]")) return null;
  if ([...document.documentElement.attributes].some(attribute => attribute.name !== "lang")) return null;
  if (Number(root.getAttribute("data-width")) !== project.canvas.width || Number(root.getAttribute("data-height")) !== project.canvas.height) return null;
  const rootAttributes = new Set(["id", "data-hf-id", "data-composition-id", "data-start", "data-duration", "data-width", "data-height"]);
  if (document.body.attributes.length || [...root.attributes].some(attribute => !rootAttributes.has(attribute.name)) || Number(root.getAttribute("data-start") ?? 0) !== 0) return null;
  for (const node of document.body.childNodes) {
    if (node === root || node.nodeType === 8 || (node.nodeType === 3 && !node.textContent?.trim())) continue;
    if (node.nodeType === 1 && ["script", "style"].includes((node as Element).tagName.toLowerCase())) continue;
    return null;
  }
  if (!hasOnlyBoilerplateStyles(document, project.canvas) || !hasOnlyBoilerplateScripts(document, compositionId)) return null;
  if ([...root.childNodes].some(node => node.nodeType === 3 && node.textContent?.trim())) return null;
  if (root.children.length !== clips.length || document.querySelectorAll("video, audio, img").length !== clips.length) return null;
  const imported = parseNativeProjectDocument(project);
  imported.mediaEngine = "ffmpeg";
  const durationFrames = Math.round(Number(root.getAttribute("data-duration")) * project.frameRate.numerator / project.frameRate.denominator);
  if (!Number.isSafeInteger(durationFrames) || durationFrames < Math.max(...clips.map(clip => clip.startFrame + clip.durationFrames))) return null;
  imported.sequence.durationFrames = durationFrames;
  for (const style of document.querySelectorAll("style")) {
    for (const match of (style.textContent ?? "").matchAll(/background(?:-color)?\s*:\s*([^;}]+)/g)) {
      const color = match[1].trim().toLowerCase();
      if (color === "black") imported.canvas.background = "#000000";
      else if (/^#[\da-f]{6}$/.test(color)) imported.canvas.background = color;
      else return null;
    }
  }
  const owned = new Set<Element>();
  for (const track of imported.sequence.tracks) for (const clip of track.clips) {
    const asset = imported.assets.find(candidate => candidate.id === clip.assetId)!;
    const binding = clip.binding;
    if (!binding || binding.sourceFile !== "index.html") return null;
    const matches = [...root.children].filter(element =>
      (!binding.domId || element.id === binding.domId) &&
      (!binding.hfId || element.getAttribute("data-hf-id") === binding.hfId) &&
      (!!binding.domId || !!binding.hfId),
    );
    if (matches.length !== 1) return null;
    const element = matches[0]!;
    if (owned.has(element) || element.tagName.toLowerCase() !== (asset.kind === "image" ? "img" : asset.kind) || element.children.length || element.textContent?.trim()) return null;
    owned.add(element);
    const geometry = mediaGeometry(element);
    if (!geometry) return null;
    clip.staticParameters = { ...geometry, ...clip.staticParameters };
    const attributes = new Set(["id", "class", "src", "style", "playsinline", "muted", "data-hf-id", "data-studio-clip-id", "data-start", "data-duration", "data-track-index", "data-source-duration", "data-playback-start", "data-media-start", "data-playback-rate", "data-has-audio", "data-volume"]);
    if ([...element.attributes].some(attribute => !attributes.has(attribute.name)) || [...element.classList].some(name => name !== "clip")) return null;
    const source = element.getAttribute("src");
    if (!source || source.includes("?") || source.includes("#")) return null;
    let path: string | null;
    try { path = nativeMediaSource(decodeURIComponent(source), project.id); } catch { return null; }
    if (!path || (asset.source && asset.source !== path)) return null;
    asset.source = path;
    // HTML-only audio settings must survive conversion into media data.
    if (element.hasAttribute("muted") || element.getAttribute("data-has-audio") === "false") clip.muted = true;
    if (element.hasAttribute("data-volume") && clip.staticParameters?.["audio.volume"] === undefined) {
      const volume = Number(element.getAttribute("data-volume"));
      if (!Number.isFinite(volume) || volume < 0) return null;
      clip.staticParameters = { ...clip.staticParameters, "audio.volume": volume };
    }
    delete clip.binding;
  }
  const visuals = imported.sequence.tracks.flatMap(track => track.clips).filter(clip => imported.assets.find(asset => asset.id === clip.assetId)?.kind !== "audio");
  for (const [index, clip] of visuals.entries()) {
    if (visuals.slice(index + 1).some(other =>
      other.staticParameters?.["layout.zIndex"] === clip.staticParameters?.["layout.zIndex"] &&
      other.startFrame < clip.startFrame + clip.durationFrames && clip.startFrame < other.startFrame + other.durationFrames,
    )) return null; // Equal-z legacy pictures depend on DOM paint order, which is not project track order.
  }
  try { assertNativeTimelineSupported(imported); } catch { return null; }
  return imported;
}
