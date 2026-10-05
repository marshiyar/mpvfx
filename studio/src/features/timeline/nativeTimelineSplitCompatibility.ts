import { splitElementInHtml } from "@hyperframes/studio-server/source-mutation";
import { advanceSourcePosition, sourceFrameValue } from "../../../shared/project/nativeSourceTime";
import {
  nativeAssetConsumesSourceFrames,
  type NativeClipDomBinding,
  type NativeProjectClip,
  type NativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import type { TimelineElement } from "../../player/index";
import { applyPatchByTarget } from "../legacy/sourcePatcher";
import type { NativeTimelineSplitCompatibilityEdit } from "../project/nativeTimelineSplitTransaction";
import { splitAudioAutomationInHtml } from "./splitAudioAutomation";
import { playbackStartAttributeForElement } from "./timelineEditingHelpers";

export const nativeBindingTarget = (binding: Readonly<NativeClipDomBinding>) => ({
  ...(binding.domId ? { id: binding.domId } : {}),
  ...(binding.hfId ? { hfId: binding.hfId } : {}),
  ...(binding.selector ? { selector: binding.selector } : {}),
  ...(binding.selectorIndex == null ? {} : { selectorIndex: binding.selectorIndex }),
});

const frameSeconds = (frame: number, document: NativeProjectDocument): number =>
  (frame * document.frameRate.denominator) / document.frameRate.numerator;

const patchExactSplitAttributes = (
  content: string,
  target: ReturnType<typeof nativeBindingTarget>,
  values: { startFrame: number; durationFrames: number; sourceInFrame: number },
  document: NativeProjectDocument,
  playbackProperty: "media-start" | "playback-start",
): string => {
  let patched = applyPatchByTarget(content, target, {
    type: "attribute", property: "start", value: String(frameSeconds(values.startFrame, document)),
  });
  patched = applyPatchByTarget(patched, target, {
    type: "attribute", property: "duration", value: String(frameSeconds(values.durationFrames, document)),
  });
  return applyPatchByTarget(patched, target, {
    type: "attribute", property: playbackProperty, value: String(frameSeconds(values.sourceInFrame, document)),
  });
};

/** The exact compatibility transform shared by razor splits and silence cuts. */
export function patchNativeTimelineSplitCompatibility(
  content: string,
  edit: NativeTimelineSplitCompatibilityEdit,
  clip: NativeProjectClip,
  document: NativeProjectDocument,
  element: Pick<TimelineElement, "kind" | "playbackStartAttr">,
): { content: string; rightBinding: NativeClipDomBinding } {
  const leftBinding = edit.leftBinding;
  const baseId = `${leftBinding.domId ?? clip.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-split`;
  const rate = clip.playbackRate ?? { numerator: 1, denominator: 1 };
  const split = splitElementInHtml(
    content,
    nativeBindingTarget(leftBinding),
    edit.compatibilitySplitSeconds,
    baseId,
    {
      start: frameSeconds(clip.startFrame, document),
      duration: frameSeconds(clip.durationFrames, document),
      playbackStart: frameSeconds(sourceFrameValue(clip), document),
      playbackRate: rate.numerator / rate.denominator,
      stampPlaybackStart: true,
    },
  );
  if (!split.matched || !split.newId) {
    throw new Error(`Compatibility source did not match native clip ${clip.id}`);
  }
  const localFrames = edit.splitFrame - clip.startFrame;
  const asset = document.assets.find(asset => asset.id === clip.assetId)!;
  const rightSource = advanceSourcePosition(
    clip, nativeAssetConsumesSourceFrames(asset.kind) ? localFrames : 0,
  );
  const playbackProperty = playbackStartAttributeForElement(element).slice("data-".length) as
    "media-start" | "playback-start";
  let patched = patchExactSplitAttributes(
    split.html, nativeBindingTarget(leftBinding),
    { startFrame: clip.startFrame, durationFrames: localFrames, sourceInFrame: sourceFrameValue(clip) },
    document, playbackProperty,
  );
  const rightBinding: NativeClipDomBinding = { sourceFile: edit.sourceFile, domId: split.newId };
  patched = splitAudioAutomationInHtml(
    patched, nativeBindingTarget(leftBinding), nativeBindingTarget(rightBinding),
    frameSeconds(localFrames, document),
  );
  patched = patchExactSplitAttributes(
    patched, nativeBindingTarget(rightBinding),
    { startFrame: edit.splitFrame, durationFrames: clip.durationFrames - localFrames,
      sourceInFrame: sourceFrameValue(rightSource) },
    document, playbackProperty,
  );
  return { content: patched, rightBinding };
}
