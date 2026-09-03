import {
  findNativeProjectTrackByLane,
  type NativeProjectDocument,
  type NativeProjectTrackLane,
} from "./nativeProjectDocument";
import {
  applyNativeProjectClipCommand,
  type NativeProjectClipAddress,
} from "./nativeProjectClipCommands";
import {
  projectFrameFromSeconds,
  resolveNativeClipSelection,
  type NativeSelectedElementReference,
} from "./nativePropertyEditPlan";

export interface NativeTimelineMoveElement extends NativeSelectedElementReference {
  readonly currentTrack: number;
}

export interface NativeTimelineClipMovePlanInput {
  readonly document: NativeProjectDocument;
  readonly element: NativeTimelineMoveElement;
  readonly requestedStartSeconds: number;
  readonly requestedTrack: number;
}

export type NativeTimelineClipMovePlanFailureCode =
  | "unsupported-lane-change"
  | "invalid-start"
  | "clip-not-found"
  | "ambiguous-clip"
  | "missing-selection-id"
  | "native-command-rejected";

export type NativeTimelineClipMovePlanResult =
  | {
      readonly ok: true;
      readonly document: NativeProjectDocument;
      readonly address: NativeProjectClipAddress;
      readonly sourceFile: string;
      readonly startFrame: number;
      readonly compatibilityStartSeconds: number;
      readonly destination: NativeProjectTrackLane & { readonly trackId: string };
    }
  | {
      readonly ok: false;
      readonly failure: {
        readonly code: NativeTimelineClipMovePlanFailureCode;
        readonly message: string;
      };
    };

const fail = (
  code: NativeTimelineClipMovePlanFailureCode,
  message: string,
): NativeTimelineClipMovePlanResult => ({ ok: false, failure: { code, message } });

/**
 * Plan one clip move with native integer frames and explicit native lane
 * metadata as the sole authorities. Returned seconds and authored/display lane
 * values exist only for the transitional compatibility HTML mirror.
 */
export function planNativeTimelineClipMove(
  input: NativeTimelineClipMovePlanInput,
): NativeTimelineClipMovePlanResult {
  if (!Number.isFinite(input.requestedStartSeconds) || input.requestedStartSeconds < 0) {
    return fail("invalid-start", "Native timeline start must be a finite non-negative time");
  }

  const resolution = resolveNativeClipSelection(input.document, input.element);
  if (!resolution.ok) {
    const code = resolution.failure.code;
    if (
      code === "clip-not-found" ||
      code === "ambiguous-clip" ||
      code === "missing-selection-id"
    ) {
      return fail(code, resolution.failure.message);
    }
    return fail("clip-not-found", resolution.failure.message);
  }
  const { clip, trackId } = resolution.located;
  const sourceTrack = input.document.sequence.tracks.find((track) => track.id === trackId);
  if (!sourceTrack?.lane) {
    return fail(
      "unsupported-lane-change",
      "The selected clip has no explicit authored/display native lane mapping",
    );
  }
  const destinationTrack =
    input.requestedTrack === input.element.currentTrack
      ? sourceTrack
      : findNativeProjectTrackByLane(input.document, {
          kind: sourceTrack.kind,
          authoredTrack: input.requestedTrack,
        });
  if (!destinationTrack?.lane) {
    return fail(
      "unsupported-lane-change",
      `Authored lane ${input.requestedTrack} has no mapped compatible native track`,
    );
  }
  const sourceFile = clip.binding?.sourceFile;
  if (!sourceFile) {
    return fail("clip-not-found", `Native clip ${clip.id} has no compatibility source binding`);
  }

  const startFrame = projectFrameFromSeconds(input.requestedStartSeconds, input.document.frameRate);
  const address: NativeProjectClipAddress = {
    sequenceId: input.document.sequence.id,
    trackId,
    clipId: clip.id,
  };
  const command = applyNativeProjectClipCommand(input.document, {
    type: "move",
    address,
    destination: { trackId: destinationTrack.id, startFrame },
  });
  if (!command.ok) {
    return fail("native-command-rejected", command.failure.message);
  }

  return {
    ok: true,
    document: command.document,
    address,
    sourceFile,
    startFrame,
    compatibilityStartSeconds:
      (startFrame * input.document.frameRate.denominator) /
      input.document.frameRate.numerator,
    destination: {
      trackId: destinationTrack.id,
      authoredTrack: destinationTrack.lane.authoredTrack,
      displayTrack: destinationTrack.lane.displayTrack,
    },
  };
}
