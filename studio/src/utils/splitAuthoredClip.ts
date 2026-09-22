import { captureAuthoredClips, pasteAuthoredClips } from "./authoredClipClipboard";
import { applyPatchByTarget, type PatchTarget } from "./sourcePatcher";
import { splitAudioAutomationInHtml } from "./splitAudioAutomation";

/** Split visibility and source ranges while retaining complete independent curves. */
export function splitAuthoredClip(
  source: string,
  target: PatchTarget,
  splitSeconds: number,
  nonce: string,
  timing?: {
    start: number;
    duration: number;
    sourceIn: number;
    rate: number;
    still: boolean;
  },
) {
  const snapshot = captureAuthoredClips(source, [target]);
  const element = new DOMParser().parseFromString(snapshot.html[0]!, "text/html").body
    .firstElementChild!;
  const start = timing?.start ?? snapshot.starts[0]!;
  const duration = timing?.duration ?? Number(element.getAttribute("data-duration"));
  const local = splitSeconds - start;
  if (!Number.isFinite(local) || local <= 0 || local >= duration)
    throw new Error("Split must leave a non-empty clip on each side.");
  const media = element.matches("video,audio");
  const playbackProperty = media ? "data-media-start" : "data-playback-start";
  const offset = timing?.sourceIn ?? Number(element.getAttribute(playbackProperty) ?? 0);
  const rate = timing?.rate ?? Number(element.getAttribute("data-playback-rate") ?? 1);
  if (!Number.isFinite(offset) || !Number.isFinite(rate) || rate <= 0)
    throw new Error("Invalid source timing.");
  // Clone at the old origin so all authored animation remains at its original
  // project time. The new In hides earlier motion without reconstructing it.
  const pasted = pasteAuthoredClips(source, snapshot, snapshot.starts[0]!, nonce, "split");
  const binding = pasted.bindings[0]!;
  const rightTarget = { id: binding.domId, hfId: binding.hfId };
  let content = applyPatchByTarget(pasted.content, target, {
    type: "attribute",
    property: "duration",
    value: String(local),
  });
  content = applyPatchByTarget(content, rightTarget, {
    type: "attribute",
    property: "start",
    value: String(splitSeconds),
  });
  content = applyPatchByTarget(content, rightTarget, {
    type: "attribute",
    property: "duration",
    value: String(duration - local),
  });
  if (media || element.hasAttribute("data-composition-src")) {
    content = applyPatchByTarget(content, rightTarget, {
      type: "attribute",
      property: playbackProperty,
      value: String(offset + (timing?.still ? 0 : local * rate)),
    });
  }
  content = splitAudioAutomationInHtml(content, target, rightTarget, local);
  return { content, binding };
}
