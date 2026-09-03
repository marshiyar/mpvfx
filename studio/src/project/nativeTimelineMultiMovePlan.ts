import {
  findNativeProjectTrackByLane,
  type NativeClipDomBinding,
  type NativeProjectDocument,
  type NativeProjectTrackKind,
  type NativeProjectTrackLane,
} from "./nativeProjectDocument";
import {
  applyNativeProjectClipCommand,
  type NativeProjectClipAddress,
  type NativeProjectClipMove,
} from "./nativeProjectClipCommands";
import {
  projectFrameFromSeconds,
  resolveNativeClipSelection,
  type NativeSelectedElementReference,
} from "./nativePropertyEditPlan";

export interface NativeTimelineMultiMoveChange {
  readonly element: NativeSelectedElementReference;
  readonly requestedStartSeconds: number;
  /** Authored compatibility lane. Omit to retain the clip's native track. */
  readonly destinationAuthoredTrack?: number;
}

export interface NativeTimelineMultiMovePlanInput {
  readonly document: NativeProjectDocument;
  readonly changes: readonly NativeTimelineMultiMoveChange[];
}

export interface NativeTimelineMultiMoveDestination extends NativeProjectTrackLane {
  readonly trackId: string;
}

export interface NativeTimelineMultiMovePlannedMove {
  readonly address: NativeProjectClipAddress;
  readonly sourceFile: string;
  readonly binding: Readonly<NativeClipDomBinding>;
  readonly startFrame: number;
  readonly compatibilityStartSeconds: number;
  readonly destination: NativeTimelineMultiMoveDestination;
}

export type NativeTimelineMultiMovePlanFailureCode =
  | "empty-change-set"
  | "invalid-start"
  | "missing-selection-id"
  | "clip-not-found"
  | "ambiguous-clip"
  | "duplicate-clip"
  | "unbound-clip"
  | "binding-source-mismatch"
  | "unmapped-lane"
  | "incompatible-lane"
  | "native-command-rejected";

export type NativeTimelineMultiMovePlanResult =
  | {
      readonly ok: true;
      readonly document: NativeProjectDocument;
      readonly moves: readonly NativeTimelineMultiMovePlannedMove[];
      readonly sourceFiles: readonly string[];
    }
  | {
      readonly ok: false;
      readonly failure: {
        readonly code: NativeTimelineMultiMovePlanFailureCode;
        readonly message: string;
        readonly changeIndex?: number;
      };
    };

const fail = (
  code: NativeTimelineMultiMovePlanFailureCode,
  message: string,
  changeIndex?: number,
): NativeTimelineMultiMovePlanResult => ({
  ok: false,
  failure: { code, message, ...(changeIndex === undefined ? {} : { changeIndex }) },
});

const addressKey = (address: NativeProjectClipAddress): string =>
  JSON.stringify([address.sequenceId, address.trackId, address.clipId]);

const otherTrackKind = (kind: NativeProjectTrackKind): NativeProjectTrackKind =>
  kind === "audio" ? "video" : "audio";

/**
 * Plan a group gesture against one immutable native-project snapshot. Every
 * selected node must resolve exactly once. Project frames and explicit lane
 * metadata are canonical; seconds and authored lanes are compatibility output.
 */
export function planNativeTimelineMultiMove(
  input: NativeTimelineMultiMovePlanInput,
): NativeTimelineMultiMovePlanResult {
  if (input.changes.length === 0) {
    return fail("empty-change-set", "A native multi-clip move requires at least one change");
  }

  const planned: NativeTimelineMultiMovePlannedMove[] = [];
  const nativeMoves: NativeProjectClipMove[] = [];
  const addressed = new Set<string>();

  for (const [changeIndex, change] of input.changes.entries()) {
    if (!Number.isFinite(change.requestedStartSeconds) || change.requestedStartSeconds < 0) {
      return fail(
        "invalid-start",
        "Native timeline starts must be finite non-negative times",
        changeIndex,
      );
    }

    const resolution = resolveNativeClipSelection(input.document, change.element);
    if (!resolution.ok) {
      const code = resolution.failure.code;
      if (code === "missing-selection-id" || code === "clip-not-found" || code === "ambiguous-clip") {
        return fail(code, resolution.failure.message, changeIndex);
      }
      return fail("clip-not-found", resolution.failure.message, changeIndex);
    }

    const { clip, trackId } = resolution.located;
    const sourceTrack = input.document.sequence.tracks.find((track) => track.id === trackId);
    if (!sourceTrack) {
      return fail("clip-not-found", `Native source track ${trackId} does not exist`, changeIndex);
    }
    if (!clip.binding) {
      return fail(
        "unbound-clip",
        `Native clip ${clip.id} has no compatibility source binding`,
        changeIndex,
      );
    }
    if (
      typeof change.element.sourceFile === "string" &&
      change.element.sourceFile.length > 0 &&
      change.element.sourceFile !== clip.binding.sourceFile
    ) {
      return fail(
        "binding-source-mismatch",
        `Selected source ${change.element.sourceFile} does not match native binding ${clip.binding.sourceFile}`,
        changeIndex,
      );
    }
    if (!sourceTrack.lane) {
      return fail(
        "unmapped-lane",
        `Native source track ${sourceTrack.id} has no explicit lane mapping`,
        changeIndex,
      );
    }

    const authoredTrack = change.destinationAuthoredTrack ?? sourceTrack.lane.authoredTrack;
    const destinationTrack = findNativeProjectTrackByLane(input.document, {
      kind: sourceTrack.kind,
      authoredTrack,
    });
    if (!destinationTrack?.lane) {
      const incompatibleTrack = findNativeProjectTrackByLane(input.document, {
        kind: otherTrackKind(sourceTrack.kind),
        authoredTrack,
      });
      return incompatibleTrack
        ? fail(
            "incompatible-lane",
            `Authored lane ${authoredTrack} is mapped only to an incompatible ${incompatibleTrack.kind} track`,
            changeIndex,
          )
        : fail(
            "unmapped-lane",
            `Authored lane ${authoredTrack} has no mapped ${sourceTrack.kind} track`,
            changeIndex,
          );
    }

    const address: NativeProjectClipAddress = {
      sequenceId: input.document.sequence.id,
      trackId,
      clipId: clip.id,
    };
    const key = addressKey(address);
    if (addressed.has(key)) {
      return fail(
        "duplicate-clip",
        `Native clip ${clip.id} is targeted more than once by the same gesture`,
        changeIndex,
      );
    }
    addressed.add(key);

    const startFrame = projectFrameFromSeconds(
      change.requestedStartSeconds,
      input.document.frameRate,
    );
    const destination = {
      trackId: destinationTrack.id,
      authoredTrack: destinationTrack.lane.authoredTrack,
      displayTrack: destinationTrack.lane.displayTrack,
    };
    planned.push({
      address,
      sourceFile: clip.binding.sourceFile,
      binding: { ...clip.binding },
      startFrame,
      compatibilityStartSeconds:
        (startFrame * input.document.frameRate.denominator) /
        input.document.frameRate.numerator,
      destination,
    });
    nativeMoves.push({
      address,
      destination: { trackId: destination.trackId, startFrame },
    });
  }

  const command = applyNativeProjectClipCommand(input.document, {
    type: "move-many",
    moves: nativeMoves,
  });
  if (!command.ok) {
    return fail("native-command-rejected", command.failure.message);
  }

  return {
    ok: true,
    document: command.document,
    moves: planned,
    sourceFiles: [...new Set(planned.map((move) => move.sourceFile))].sort(),
  };
}
