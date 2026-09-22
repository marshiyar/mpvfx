import {
  createNativeParameterTrack,
  type NativeKeyframe,
  type NativeValueType,
  type RationalFrameRate,
} from "./nativeKeyframeTypes";
import { parseNativeProjectDocument, type NativeProjectDocument } from "./nativeProjectDocument";
import {
  nativeParameterTrackId,
  type NativeProjectParameterAddress,
} from "./nativeProjectKeyframeCommands";
import type { NativeSelectedKeyframeAddress } from "../player/components/deleteSelectedKeyframes";

export interface NativeKeyframeClipboard {
  readonly frameRate: RationalFrameRate;
  readonly keys: readonly {
    parameterId: string;
    valueType: NativeValueType;
    offsetFrame: number;
    key: NativeKeyframe;
  }[];
}
function locate(
  document: NativeProjectDocument,
  address: Omit<NativeProjectParameterAddress, "parameterId">,
) {
  if (document.sequence.id !== address.sequenceId)
    throw new Error("The keyframe sequence is unavailable.");
  const clip = document.sequence.tracks
    .find((t) => t.id === address.trackId)
    ?.clips.find((c) => c.id === address.clipId);
  if (!clip) throw new Error("The keyframe clip is unavailable.");
  return clip;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function captureNativeKeyframes(
  document: NativeProjectDocument,
  selection: readonly NativeSelectedKeyframeAddress[],
): NativeKeyframeClipboard {
  if (!selection.length) throw new Error("Select keyframes to copy.");
  const unique = new Map<string, NativeKeyframeClipboard["keys"][number]>();
  for (const item of selection) {
    const clip = locate(document, item.address);
    const track = clip.parameterTracks.find((t) => t.parameterId === item.address.parameterId);
    const key = track?.keyframes.find((k) => k.frame === item.frame);
    if (!track || !key) throw new Error("A selected keyframe no longer exists.");
    unique.set(JSON.stringify([item.address, item.frame]), {
      parameterId: track.parameterId,
      valueType: track.valueType,
      offsetFrame: clip.startFrame + key.frame,
      key: clone(key),
    });
  }
  const keys = [...unique.values()];
  const first = Math.min(...keys.map((k) => k.offsetFrame));
  return {
    frameRate: { ...document.frameRate },
    keys: keys.map((k) => ({ ...k, offsetFrame: k.offsetFrame - first })),
  };
}

/** Paste preserves time and outgoing interpolation. Occupied frames reject the whole operation. */
export function pasteNativeKeyframes(
  document: NativeProjectDocument,
  clipboard: NativeKeyframeClipboard,
  destination: Omit<NativeProjectParameterAddress, "parameterId">,
  projectFrame: number,
  nonce: string,
): {
  document: NativeProjectDocument;
  selection: NativeSelectedKeyframeAddress[];
} {
  if (
    document.frameRate.numerator !== clipboard.frameRate.numerator ||
    document.frameRate.denominator !== clipboard.frameRate.denominator
  )
    throw new Error("Keyframe paste requires the same frame rate.");
  const next = clone(document);
  const clip = locate(next, destination);
  const asset = next.assets.find((candidate) => candidate.id === clip.assetId);
  if (
    asset?.kind === "audio" &&
    clipboard.keys.some((key) => /^(transform|visual|layout)\./.test(key.parameterId))
  )
    throw new Error("Visual keyframes require a compatible video or image clip.");
  const local = projectFrame - clip.startFrame;
  if (!Number.isSafeInteger(local) || local < 0 || local >= clip.durationFrames)
    throw new Error("Place the playhead inside the destination clip before pasting keyframes.");
  const selection: NativeSelectedKeyframeAddress[] = [];
  for (const [index, copied] of clipboard.keys.entries()) {
    let track = clip.parameterTracks.find((t) => t.parameterId === copied.parameterId);
    if (track && track.valueType !== copied.valueType)
      throw new Error("The destination parameter has an incompatible value type.");
    const frame = local + copied.offsetFrame;
    if (!Number.isSafeInteger(frame)) throw new Error("Invalid keyframe paste time.");
    if (track?.keyframes.some((k) => k.frame === frame))
      throw new Error(
        "A destination keyframe is occupied. Move the playhead or delete the destination keys first.",
      );
    const updated = createNativeParameterTrack({
      id: track?.id ?? nativeParameterTrackId(clip.id, copied.parameterId),
      parameterId: copied.parameterId,
      valueType: copied.valueType,
      frameRate: next.frameRate,
      keyframes: [
        ...(track?.keyframes ?? []),
        { ...clone(copied.key), id: `pasted:${nonce}:${index}`, frame },
      ],
    });
    if (track) clip.parameterTracks[clip.parameterTracks.indexOf(track)] = updated;
    else clip.parameterTracks.push(updated);
    selection.push({
      address: { ...destination, parameterId: copied.parameterId },
      frame,
    });
  }
  return { document: parseNativeProjectDocument(next), selection };
}
