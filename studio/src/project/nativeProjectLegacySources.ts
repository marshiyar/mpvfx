/** Build exact legacy-animation sources for the native bootstrap merger. */
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";

import type { TimelineElement } from "../player/store/timelineElement";
import type { NativeClipDomBinding, NativeProjectDocument } from "./nativeProjectDocument";
import type { LegacyGsapNativeBootstrapSource } from "./legacyGsapNativeBootstrap";

export interface LegacyGsapAnimationFile {
  readonly sourceFile: string;
  readonly animations: readonly GsapAnimation[];
}

export interface UnmatchedLegacyGsapAnimation {
  readonly sourceFile: string;
  readonly animation: GsapAnimation;
  readonly reason: "dynamic-selector" | "no-native-clip-match";
}

export interface LegacyGsapNativeSourcesResult {
  readonly sources: readonly LegacyGsapNativeBootstrapSource[];
  readonly unmatched: readonly UnmatchedLegacyGsapAnimation[];
}

interface ClipBinding {
  readonly clipId: string;
  readonly binding: NativeClipDomBinding;
}

const bindingKeys: ReadonlyArray<keyof NativeClipDomBinding> = [
  "sourceFile",
  "domId",
  "hfId",
  "selector",
  "selectorIndex",
];

function bindingOf(element: TimelineElement): NativeClipDomBinding | null {
  if (!element.sourceFile) return null;
  const domId = element.domId?.trim() || undefined;
  const hfId = element.hfId?.trim() || undefined;
  const selector = element.selector?.trim() || undefined;
  if (!domId && !hfId && !selector) return null;
  return {
    sourceFile: element.sourceFile,
    ...(domId ? { domId } : {}),
    ...(hfId ? { hfId } : {}),
    ...(selector ? { selector } : {}),
    ...(element.selectorIndex !== undefined ? { selectorIndex: element.selectorIndex } : {}),
  };
}

function sameBinding(left: NativeClipDomBinding | undefined, right: NativeClipDomBinding): boolean {
  return !!left && bindingKeys.every((key) => left[key] === right[key]);
}

function clipsForElements(
  document: NativeProjectDocument,
  elements: readonly TimelineElement[],
): Map<string, ClipBinding> {
  const byBinding = new Map<string, ClipBinding>();
  for (const track of document.sequence.tracks) {
    for (const clip of track.clips) {
      if (!clip.binding) continue;
      const key = JSON.stringify(bindingKeys.map((field) => clip.binding?.[field] ?? null));
      byBinding.set(key, { clipId: clip.id, binding: clip.binding });
    }
  }
  const result = new Map<string, ClipBinding>();
  for (const element of elements) {
    const binding = bindingOf(element);
    if (!binding) continue;
    const key = JSON.stringify(bindingKeys.map((field) => binding[field] ?? null));
    const clip = byBinding.get(key);
    if (clip && sameBinding(clip.binding, binding)) result.set(element.id, clip);
  }
  return result;
}

function selectorMatchesElement(animation: GsapAnimation, element: TimelineElement): boolean {
  if (animation.hasUnresolvedSelector) return false;
  const targets = animation.targetSelector.split(",").map((target) => target.trim()).filter(Boolean);
  const identity = new Set<string>();
  if (element.domId) identity.add(`#${element.domId}`);
  if (element.hfId) identity.add(`#${element.hfId}`);
  if (element.selector) identity.add(element.selector.trim());
  return targets.some((target) => {
    if (identity.has(target)) return true;
    const last = target.split(/\s+/).at(-1);
    return !!last && identity.has(last);
  });
}

/**
 * Attribute parsed animations to native clips only when their source selector
 * and exact clip binding agree. Dynamic selectors are deliberately surfaced as
 * unmatched instead of being guessed onto a clip.
 */
export function buildLegacyGsapNativeSources(
  document: NativeProjectDocument,
  elements: readonly TimelineElement[],
  files: readonly LegacyGsapAnimationFile[],
): LegacyGsapNativeSourcesResult {
  const clipsByElement = clipsForElements(document, elements);
  const grouped = new Map<string, { source: LegacyGsapNativeBootstrapSource; order: number }>();
  const unmatched: UnmatchedLegacyGsapAnimation[] = [];

  for (const file of files) {
    const fileElements = elements.filter((element) => element.sourceFile === file.sourceFile);
    for (const animation of file.animations) {
      if (animation.hasUnresolvedSelector) {
        unmatched.push({ sourceFile: file.sourceFile, animation, reason: "dynamic-selector" });
        continue;
      }
      const matches = fileElements
        .filter((element) => selectorMatchesElement(animation, element))
        .map((element) => clipsByElement.get(element.id))
        .filter((clip): clip is ClipBinding => clip !== undefined);
      if (matches.length === 0) {
        unmatched.push({ sourceFile: file.sourceFile, animation, reason: "no-native-clip-match" });
        continue;
      }
      for (const match of matches) {
        const current = grouped.get(match.clipId);
        if (current) {
          current.source = {
            ...current.source,
            animations: [...current.source.animations, animation],
          };
        } else {
          grouped.set(match.clipId, {
            source: { clipId: match.clipId, binding: match.binding, animations: [animation] },
            order: grouped.size,
          });
        }
      }
    }
  }

  const sources = [...grouped.values()]
    .map(({ source }) => ({
      ...source,
      animations: [...source.animations].sort((left, right) => left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => (left.clipId ?? "").localeCompare(right.clipId ?? ""));
  unmatched.sort(
    (left, right) =>
      left.sourceFile.localeCompare(right.sourceFile) || left.animation.id.localeCompare(right.animation.id),
  );
  return { sources, unmatched };
}
