import {
  parse,
  type AssignmentExpression,
  type CallExpression,
  type ExpressionStatement,
  type Identifier,
  type Literal,
  type MemberExpression,
  type Node,
  type ObjectExpression,
  type Property,
} from "acorn";
import type { RationalFrameRate } from "../project/nativeKeyframeTypes";
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from "./mediaTypes";
import { roundToCenti } from "./rounding";
import { patchRootCompositionDuration, readRootCompositionDuration } from "./rootDuration";
import { applyPatchByTarget, type PatchTarget } from "./sourcePatcher";

export const TIMELINE_ASSET_MIME = "application/x-hyperframes-asset";
export const TIMELINE_BLOCK_MIME = "application/x-hyperframes-block";
const FALLBACK_TIMELINE_FILE_DROP_DURATION = 5;

export type TimelineAssetKind = "image" | "video" | "audio";

interface SourceOpenTag {
  text: string;
  index: number;
  end: number;
  name: string;
  contentEnd?: number;
}

/**
 * Minimal source-preserving HTML scan used only to locate insertion points.
 * It skips comments plus script/style/template bodies, so example markup cannot
 * masquerade as the live composition root. A DOM serialization is deliberately
 * avoided because it would rewrite the user's whole source file.
 */
function scanSourceOpenTags(source: string): SourceOpenTag[] {
  const tags: SourceOpenTag[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) break;
    if (source.startsWith("<!--", start)) {
      const commentEnd = source.indexOf("-->", start + 4);
      cursor = commentEnd < 0 ? source.length : commentEnd + 3;
      continue;
    }
    if (/^<\s*[!/?]/.test(source.slice(start, start + 4))) {
      const declarationEnd = source.indexOf(">", start + 1);
      cursor = declarationEnd < 0 ? source.length : declarationEnd + 1;
      continue;
    }

    let quote: '"' | "'" | null = null;
    let end = start + 1;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end >= source.length) break;
    const text = source.slice(start, end + 1);
    const name = text.match(/^<\s*([a-z][\w:-]*)/i)?.[1]?.toLowerCase();
    if (!name) {
      cursor = end + 1;
      continue;
    }

    const tag: SourceOpenTag = { text, index: start, end: end + 1, name };
    tags.push(tag);
    if (["script", "style", "template"].includes(name)) {
      const closing = new RegExp(`</\\s*${name}\\s*>`, "gi");
      closing.lastIndex = end + 1;
      const closeMatch = closing.exec(source);
      tag.contentEnd = closeMatch?.index ?? source.length;
      cursor = closeMatch ? closeMatch.index + closeMatch[0].length : source.length;
    } else {
      cursor = end + 1;
    }
  }
  return tags;
}

function readSourceTagAttribute(tag: SourceOpenTag, name: string): string | null {
  const pattern = new RegExp(
    "(?:^|\\s)" +
      name +
      "(?=\\s|=|/?>)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+)))?",
    "i",
  );
  const match = pattern.exec(tag.text);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function findCompositionRootOpenTag(source: string): SourceOpenTag | null {
  return (
    scanSourceOpenTags(source).find((tag) => {
      const id = readSourceTagAttribute(tag, "data-composition-id");
      return id !== null && id.trim().length > 0;
    }) ?? null
  );
}

function isExecutableInlineScript(tag: SourceOpenTag): boolean {
  if (readSourceTagAttribute(tag, "src") !== null) return false;
  const declaredType = (readSourceTagAttribute(tag, "type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!declaredType || declaredType === "module") return true;
  return (
    /^(?:text|application)\/(?:x-)?(?:java|ecma)script(?:1\.[0-5])?$/.test(declaredType) ||
    declaredType === "text/jscript" ||
    declaredType === "text/livescript"
  );
}

function staticMemberName(member: MemberExpression): string | null {
  const property = member.property;
  if (!member.computed && property.type === "Identifier") {
    return (property as Identifier).name;
  }
  if (member.computed && property.type === "Literal") {
    const value = (property as Literal).value;
    return typeof value === "string" ? value : null;
  }
  return null;
}

function timelineRegistryId(node: Node): string | null {
  if (node.type !== "MemberExpression") return null;
  const registration = node as MemberExpression;
  if (registration.object.type !== "MemberExpression") return null;
  const registry = registration.object as MemberExpression;
  if (staticMemberName(registry) !== "__timelines") return null;
  if (registry.object.type !== "Identifier" || (registry.object as Identifier).name !== "window") {
    return null;
  }
  return staticMemberName(registration);
}

function isGsapTimelineCall(node: Node): node is CallExpression {
  if (node.type !== "CallExpression") return false;
  const call = node as CallExpression;
  if (call.callee.type !== "MemberExpression") return false;
  const callee = call.callee as MemberExpression;
  return (
    callee.object.type === "Identifier" &&
    (callee.object as Identifier).name === "gsap" &&
    staticMemberName(callee) === "timeline"
  );
}

function staticPropertyName(property: Property): string | null {
  if (property.computed) return null;
  if (property.key.type === "Identifier") return (property.key as Identifier).name;
  if (property.key.type === "Literal") {
    const value = (property.key as Literal).value;
    return typeof value === "string" ? value : null;
  }
  return null;
}

function hasUnambiguousPausedOption(call: CallExpression): boolean {
  const options = call.arguments[0];
  if (!options || options.type !== "ObjectExpression") return false;
  const properties = (options as ObjectExpression).properties;
  if (properties.some((property) => property.type !== "Property" || property.computed)) return false;

  const paused = (properties as Property[]).filter(
    (property) => staticPropertyName(property) === "paused",
  );
  if (paused.length !== 1) return false;
  const property = paused[0];
  return (
    property.kind === "init" &&
    !property.method &&
    !property.shorthand &&
    property.value.type === "Literal" &&
    (property.value as Literal).value === true
  );
}

function parsedPausedTimelineIds(script: string, sourceType: "script" | "module"): string[] {
  let program;
  try {
    program = parse(script, { ecmaVersion: "latest", sourceType, allowHashBang: true });
  } catch {
    return [];
  }

  const ids: string[] = [];
  for (const statement of program.body) {
    if (statement.type !== "ExpressionStatement") continue;
    const expression = (statement as ExpressionStatement).expression;
    if (expression.type !== "AssignmentExpression") continue;
    const assignment = expression as AssignmentExpression;
    if (assignment.operator !== "=" || !isGsapTimelineCall(assignment.right)) continue;
    const id = timelineRegistryId(assignment.left);
    if (id && hasUnambiguousPausedOption(assignment.right)) ids.push(id);
  }
  return ids;
}

function findPausedTimelineId(source: string): string | null {
  const registrations: string[] = [];
  for (const tag of scanSourceOpenTags(source)) {
    if (tag.name !== "script" || tag.contentEnd == null || !isExecutableInlineScript(tag)) continue;
    const script = source.slice(tag.end, tag.contentEnd);
    const sourceType =
      readSourceTagAttribute(tag, "type")?.trim().toLowerCase() === "module"
        ? "module"
        : "script";
    registrations.push(...parsedPausedTimelineIds(script, sourceType));
  }
  return registrations.length === 1 ? registrations[0] : null;
}

function viewportDimensions(source: string): { width: number; height: number } | null {
  for (const tag of scanSourceOpenTags(source)) {
    if (tag.name !== "meta") continue;
    if (readSourceTagAttribute(tag, "name")?.toLowerCase() !== "viewport") continue;
    const content = readSourceTagAttribute(tag, "content") ?? "";
    const width = Number.parseFloat(content.match(/\bwidth\s*=\s*([0-9.]+)/i)?.[1] ?? "");
    const height = Number.parseFloat(content.match(/\bheight\s*=\s*([0-9.]+)/i)?.[1] ?? "");
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width: Math.round(width), height: Math.round(height) };
    }
  }
  return null;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function recoverTimelineAssetTargetSource(source: string): string | null {
  if (findCompositionRootOpenTag(source)) return source;
  const compositionId = findPausedTimelineId(source);
  if (!compositionId) return null;
  const tags = scanSourceOpenTags(source);
  const body = tags.find((tag) => tag.name === "body");
  if (!body) return null;
  const dimensions = viewportDimensions(source) ?? { width: 1920, height: 1080 };
  const escapedCompositionId = escapeHtmlAttribute(compositionId);
  const rootMarkup =
    `<div id="root" data-hf-id="hf-root" data-composition-id="${escapedCompositionId}" ` +
    `data-start="0" data-duration="5" data-width="${dimensions.width}" ` +
    `data-height="${dimensions.height}"></div>`;
  return `${source.slice(0, body.end)}\n    ${rootMarkup}${source.slice(body.end)}`;
}

const ROOT_3D_PROPERTY_DEFAULTS = new Map<string, string>([
  ["z", "0"],
  ["rotationX", "0"],
  ["rotationY", "0"],
  ["rotationZ", "0"],
  ["transformPerspective", "0"],
  ["perspective", "0"],
  ["transform", '"none"'],
]);

const ROOT_INLINE_TRANSFORM_PROPERTIES = [
  "transform",
  "perspective",
  "transform-style",
  "rotate",
  "scale",
  "translate",
  "backface-visibility",
] as const;

interface SourceReplacement {
  start: number;
  end: number;
  value: string;
}

function distinctNonOverlappingReplacements(
  replacements: SourceReplacement[],
): SourceReplacement[] {
  const distinct = Array.from(
    new Map(
      replacements.map((replacement) => [
        `${replacement.start}:${replacement.end}`,
        replacement,
      ]),
    ).values(),
  ).sort((a, b) => a.start - b.start || b.end - a.end);
  const selected: SourceReplacement[] = [];
  let coveredUntil = -1;
  for (const replacement of distinct) {
    if (replacement.start < coveredUntil) continue;
    selected.push(replacement);
    coveredUntil = replacement.end;
  }
  return selected;
}

function walkSyntaxTree(node: Node, visit: (current: Node) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && typeof child.type === "string") {
          walkSyntaxTree(child as Node, visit);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      const child = value as { type?: unknown };
      if (typeof child.type === "string") walkSyntaxTree(value as Node, visit);
    }
  }
}

function staticString(node: Node | undefined): string | null {
  if (!node || node.type !== "Literal") return null;
  const value = (node as Literal).value;
  return typeof value === "string" ? value : null;
}

function isKnownGsapMutationCall(call: CallExpression): boolean {
  if (call.callee.type !== "MemberExpression") return false;
  const callee = call.callee as MemberExpression;
  const method = staticMemberName(callee);
  if (!method || !["set", "to", "from", "fromTo"].includes(method)) return false;
  if (callee.object.type === "Identifier") {
    return (callee.object as Identifier).name === "gsap";
  }
  return timelineRegistryId(callee.object) !== null || isGsapTimelineCall(callee.object);
}

function collectRoot3dPropertyReplacements(
  node: Node,
  sourceOffset: number,
  replacements: SourceReplacement[],
): void {
  walkSyntaxTree(node, (current) => {
    if (current.type !== "Property") return;
    const property = current as Property;
    if (property.kind !== "init" || property.method || property.shorthand) return;
    const propertyName = staticPropertyName(property);
    const replacement = propertyName ? ROOT_3D_PROPERTY_DEFAULTS.get(propertyName) : null;
    if (!replacement) return;
    replacements.push({
      start: sourceOffset + property.value.start,
      end: sourceOffset + property.value.end,
      value: replacement,
    });
  });
}

function rootAnimationTargets(root: SourceOpenTag): Set<string> {
  const targets = new Set<string>();
  const id = readSourceTagAttribute(root, "id");
  const hfId = readSourceTagAttribute(root, "data-hf-id");
  const compositionId = readSourceTagAttribute(root, "data-composition-id");
  if (id) targets.add(`#${id}`);
  if (hfId) {
    targets.add(`[data-hf-id="${hfId}"]`);
    targets.add(`[data-hf-id='${hfId}']`);
  }
  if (compositionId) {
    targets.add(`[data-composition-id="${compositionId}"]`);
    targets.add(`[data-composition-id='${compositionId}']`);
  }
  return targets;
}

function rootPatchTarget(root: SourceOpenTag): PatchTarget | null {
  const id = readSourceTagAttribute(root, "id");
  if (id) return { id };
  const hfId = readSourceTagAttribute(root, "data-hf-id");
  if (hfId) return { hfId };
  const compositionId = readSourceTagAttribute(root, "data-composition-id");
  return compositionId ? { selector: `[data-composition-id="${compositionId}"]` } : null;
}

/**
 * The composition root is the editor's fixed canvas, not a visual clip. A 3D
 * transform authored on that ancestor affects every subsequently imported media
 * element and cannot be fixed by resetting the child. Remove those inherited
 * transforms while preserving unrelated root styles and child animations.
 */
export function neutralizeCompositionRoot3dTransforms(source: string): string {
  const root = findCompositionRootOpenTag(source);
  if (!root) return source;

  const targets = rootAnimationTargets(root);
  const replacements: SourceReplacement[] = [];
  for (const tag of scanSourceOpenTags(source)) {
    if (tag.name !== "script" || tag.contentEnd == null || !isExecutableInlineScript(tag)) continue;
    const script = source.slice(tag.end, tag.contentEnd);
    const sourceType =
      readSourceTagAttribute(tag, "type")?.trim().toLowerCase() === "module"
        ? "module"
        : "script";
    let program: Node;
    try {
      program = parse(script, { ecmaVersion: "latest", sourceType, allowHashBang: true });
    } catch {
      continue;
    }

    walkSyntaxTree(program, (node) => {
      if (node.type !== "CallExpression") return;
      const call = node as CallExpression;
      if (!isKnownGsapMutationCall(call)) return;
      const target = staticString(call.arguments[0] as Node | undefined);
      if (!target || !targets.has(target)) return;
      const method = staticMemberName(call.callee as MemberExpression);
      const varsIndexes = method === "fromTo" ? [1, 2] : [1];
      for (const index of varsIndexes) {
        const vars = call.arguments[index];
        if (vars?.type === "ObjectExpression") {
          collectRoot3dPropertyReplacements(vars as ObjectExpression, tag.end, replacements);
        }
      }
    });
  }

  let normalized = source;
  for (const replacement of distinctNonOverlappingReplacements(replacements).sort(
    (a, b) => b.start - a.start,
  )) {
    if (normalized.slice(replacement.start, replacement.end) === replacement.value) continue;
    normalized =
      normalized.slice(0, replacement.start) +
      replacement.value +
      normalized.slice(replacement.end);
  }

  const patchTarget = rootPatchTarget(root);
  if (!patchTarget) return normalized;
  const inlineStyle = readSourceTagAttribute(root, "style") ?? "";
  for (const property of ROOT_INLINE_TRANSFORM_PROPERTIES) {
    if (!new RegExp(`(?:^|;)\\s*${property}\\s*:`, "i").test(inlineStyle)) continue;
    normalized = applyPatchByTarget(normalized, patchTarget, {
      type: "inline-style",
      property,
      value: null,
    });
  }
  return normalized;
}

export function getTimelineAssetKind(assetPath: string): TimelineAssetKind | null {
  if (IMAGE_EXT.test(assetPath)) return "image";
  if (VIDEO_EXT.test(assetPath)) return "video";
  if (AUDIO_EXT.test(assetPath)) return "audio";
  return null;
}

export function buildTimelineAssetId(assetPath: string, existingIds: Iterable<string>): string {
  const baseName = assetPath.split("/").pop() ?? "asset";
  const normalized = baseName
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const baseId = normalized || "asset";
  const ids = new Set(existingIds);
  if (!ids.has(baseId)) return baseId;
  let suffix = 2;
  while (ids.has(`${baseId}_${suffix}`)) suffix += 1;
  return `${baseId}_${suffix}`;
}

export function resolveTimelineAssetSrc(targetPath: string, assetPath: string): string {
  const targetDir = targetPath.includes("/")
    ? targetPath.slice(0, targetPath.lastIndexOf("/"))
    : "";
  if (!targetDir) return assetPath;

  const fromParts = targetDir.split("/").filter(Boolean);
  const toParts = assetPath.split("/").filter(Boolean);
  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  const up = fromParts.map(() => "..");
  const relative = [...up, ...toParts].join("/");
  return relative || assetPath.split("/").pop() || assetPath;
}

/**
 * Sequence one or more dropped files end-to-end starting at the drop point, all on
 * the track the user dropped onto. The clip lands where the ghost showed it — we do
 * NOT bump to a different track on overlap (that produced surprise "new tracks" and,
 * because it jumped past high indices like a grain-overlay track, wild numbers).
 * MpVFX allows time-overlap on a track; the user can nudge if they want a gap.
 */
export function buildTimelineFileDropPlacements(
  placement: { start: number; track: number },
  durations: number[],
  frameRate?: RationalFrameRate,
): Array<{ start: number; track: number }> {
  const validFrameRate = Boolean(
    frameRate &&
    Number.isSafeInteger(frameRate.numerator) &&
    frameRate.numerator > 0 &&
    Number.isSafeInteger(frameRate.denominator) &&
    frameRate.denominator > 0,
  );
  if (!validFrameRate || !frameRate) {
    let nextStart = roundToCenti(Math.max(0, placement.start));
    return durations.map((rawDuration) => {
      const duration =
        Number.isFinite(rawDuration) && rawDuration > 0
          ? rawDuration
          : FALLBACK_TIMELINE_FILE_DROP_DURATION;
      const start = nextStart;
      nextStart = roundToCenti(nextStart + duration);
      return { start, track: placement.track };
    });
  }

  const frameAt = (seconds: number): number => Math.floor(
    (seconds * frameRate.numerator) / frameRate.denominator + 1e-9,
  );
  const secondsAt = (frame: number): number =>
    (frame * frameRate.denominator) / frameRate.numerator;
  let nextFrame = frameAt(Math.max(0, placement.start));
  return durations.map((rawDuration) => {
    const duration =
      Number.isFinite(rawDuration) && rawDuration > 0
        ? rawDuration
        : FALLBACK_TIMELINE_FILE_DROP_DURATION;
    const startFrame = nextFrame;
    nextFrame += Math.max(1, frameAt(duration));
    return { start: secondsAt(startFrame), track: placement.track };
  });
}

export function quantizeTimelineAssetDuration(
  duration: number,
  frameRate?: RationalFrameRate,
): number {
  if (
    !frameRate ||
    !Number.isSafeInteger(frameRate.numerator) ||
    frameRate.numerator <= 0 ||
    !Number.isSafeInteger(frameRate.denominator) ||
    frameRate.denominator <= 0
  ) {
    return roundToCenti(duration);
  }
  const durationFrames = Math.max(
    1,
    Math.floor((duration * frameRate.numerator) / frameRate.denominator + 1e-9),
  );
  return (durationFrames * frameRate.denominator) / frameRate.numerator;
}

export function resolveTimelineAssetCompositionSize(source: string): {
  width: number;
  height: number;
} {
  const width = Number.parseFloat(source.match(/\bdata-width=(["'])([^"']+)\1/i)?.[2] ?? "");
  const height = Number.parseFloat(source.match(/\bdata-height=(["'])([^"']+)\1/i)?.[2] ?? "");
  const viewport = viewportDimensions(source);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : (viewport?.width ?? 640),
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : (viewport?.height ?? 360),
  };
}

/**
 * CapCut-style placement: natural size when it fits, scaled-to-fit when
 * oversized, always centered. Unknown natural size → full-frame.
 */
export function fitTimelineAssetGeometry(
  natural: { width: number; height: number } | null,
  comp: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  if (!natural || natural.width <= 0 || natural.height <= 0) {
    return { left: 0, top: 0, width: comp.width, height: comp.height };
  }
  const scale = Math.min(1, comp.width / natural.width, comp.height / natural.height);
  const width = Math.round(natural.width * scale);
  const height = Math.round(natural.height * scale);
  return {
    left: Math.round((comp.width - width) / 2),
    top: Math.round((comp.height - height) / 2),
    width,
    height,
  };
}

export function buildTimelineAssetInsertHtml(input: {
  id: string;
  hfId: string;
  assetPath: string;
  kind: TimelineAssetKind;
  start: number;
  duration: number;
  track: number;
  zIndex: number;
  geometry?: { left: number; top: number; width: number; height: number };
}): string {
  const escapedAssetPath = escapeHtmlAttribute(input.assetPath);
  const sharedAttrs = `id="${input.id}" data-hf-id="${input.hfId}" class="clip" src="${escapedAssetPath}" data-start="${input.start}" data-duration="${input.duration}" data-track-index="${input.track}"`;
  const geometry = input.geometry ?? { left: 0, top: 0, width: 640, height: 360 };
  const visualStyles = `position: absolute; left: ${geometry.left}px; top: ${geometry.top}px; width: ${geometry.width}px; height: ${geometry.height}px; object-fit: contain; z-index: ${input.zIndex}`;

  if (input.kind === "image") {
    return `<img ${sharedAttrs} style="${visualStyles}" />`;
  }

  if (input.kind === "video") {
    return `<video ${sharedAttrs} data-has-audio="true" playsinline style="${visualStyles}"></video>`;
  }

  return `<audio ${sharedAttrs} data-volume="1" style="z-index: ${input.zIndex}"></audio>`;
}

/**
 * A clip inserted past the composition end would exist in the HTML but never
 * appear on the timeline or in playback. Extend the root's data-duration to
 * cover it (mirrors blockInstaller's behavior for installed blocks).
 */
export function extendCompositionDurationIfNeeded(source: string, requiredEnd: number): string {
  const rootDur = readRootCompositionDuration(source);
  if (rootDur == null || !Number.isFinite(rootDur) || requiredEnd <= rootDur) return source;
  // Keep enough precision for exact fractional project frames. Rounding this
  // to centiseconds can make the root shorter than its final media frame.
  const exactEnd = Math.ceil(requiredEnd * 1e12) / 1e12;
  return patchRootCompositionDuration(source, String(exactEnd));
}

/**
 * Set the composition root's `data-duration` to `contentEnd` (grow OR shrink) so the
 * timeline length tracks content — the content-driven counterpart to
 * extendCompositionDurationIfNeeded's grow-only ratchet. Used after edits that can
 * reduce the furthest clip end (delete/trim). No-op when `contentEnd` is not > 0, so
 * an empty timeline keeps its declared duration instead of collapsing to 0.
 */
export function setCompositionDurationToContent(source: string, contentEnd: number): string {
  if (!Number.isFinite(contentEnd) || contentEnd <= 0) return source;
  const rootDur = readRootCompositionDuration(source);
  if (rootDur == null) return source;
  const next = roundToCenti(contentEnd);
  if (rootDur === next) return source;
  return patchRootCompositionDuration(source, String(next));
}

export function ensureTimelineAssetTargetSource(source: string): string {
  const recoveredSource = recoverTimelineAssetTargetSource(source);
  if (!recoveredSource || !findCompositionRootOpenTag(recoveredSource)) {
    throw new Error("This composition is missing its root. Use Undo to restore it before adding media.");
  }
  return neutralizeCompositionRoot3dTransforms(recoveredSource);
}

export function assertTimelineAssetTargetSource(source: string): void {
  ensureTimelineAssetTargetSource(source);
}

export function insertTimelineAssetIntoSource(source: string, assetHtml: string): string {
  const targetSource = ensureTimelineAssetTargetSource(source);
  const match = findCompositionRootOpenTag(targetSource);
  if (!match) {
    throw new Error("This composition is missing its root. Use Undo to restore it before adding media.");
  }
  const insertAt = match.end;
  const lineStart = targetSource.lastIndexOf("\n", match.index);
  const leadingWhitespace =
    targetSource.slice(lineStart + 1, match.index).match(/^(\s*)/)?.[1] ?? "";
  const childIndent = leadingWhitespace + "  ";
  const indented = assetHtml
    .split("\n")
    .map((line, i) => (i === 0 ? line : childIndent + line))
    .join("\n");
  return `${targetSource.slice(0, insertAt)}\n${childIndent}${indented}${targetSource.slice(insertAt)}`;
}
