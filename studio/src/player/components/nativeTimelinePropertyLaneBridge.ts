import type { NativeProjectDocument } from "../../project/nativeProjectDocument";
import {
  projectNativeTimelineKeyframes,
  type NativeTimelinePropertyGroupId,
} from "../../project/nativeTimelineKeyframeProjection";
import type { TimelineElement } from "../store/playerStore";
import type { NativeTimelinePropertyLane } from "./TimelinePropertyLanes";
import type { NativeTrackHeaderSource } from "./trackHeaderLaneState";

const TIMELINE_GROUP: Readonly<
  Record<NativeTimelinePropertyGroupId, NativeTimelinePropertyLane["propertyGroup"]>
> = {
  position: "position",
  rotation: "rotation",
  scale: "scale",
  opacity: "visual",
  size: "size",
};

export interface NativeTimelineElementLaneProjection {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly clipId: string;
  readonly lanes: readonly NativeTimelinePropertyLane[];
  /** Canonical frame/evaluator input for the matching track-header labels. */
  readonly headerSource?: NativeTrackHeaderSource;
}

/**
 * Translate one timeline element's exact native project binding into the
 * neutral renderer-facing lanes consumed by timeline chrome.
 */
export function nativeTimelinePropertyLanesForElement(
  document: NativeProjectDocument,
  element: TimelineElement,
): NativeTimelineElementLaneProjection | null {
  const result = projectNativeTimelineKeyframes(document, {
    id: element.id,
    hfId: element.hfId,
    sourceFile: element.sourceFile,
    selector: element.selector,
    selectorIndex: element.selectorIndex,
  });
  if (!result.ok) return null;
  const clip = document.sequence.tracks
    .find((track) => track.id === result.trackId)
    ?.clips.find((candidate) => candidate.id === result.clipId);
  if (!clip) return null;

  return {
    sequenceId: result.sequenceId,
    trackId: result.trackId,
    clipId: result.clipId,
    headerSource: {
      frameRate: document.frameRate,
      clipStartFrame: result.clipStartFrame,
      clipDurationFrames: result.clipDurationFrames,
      parameterTracks: clip.parameterTracks,
    },
    lanes: result.groups.flatMap((group) =>
      group.lanes.map((lane) => ({
        id: lane.animationId,
        propertyGroup: TIMELINE_GROUP[group.id],
        keyframes: lane.diamonds.map((diamond) => ({
          id: diamond.keyframeId,
          percentage: diamond.percentage,
          properties: { [lane.property]: diamond.value },
          native: {
            sequenceId: result.sequenceId,
            trackId: result.trackId,
            clipId: result.clipId,
            parameterId: diamond.parameterId,
            keyframeId: diamond.keyframeId,
            frame: diamond.frame,
            clipDurationFrames: result.clipDurationFrames,
            hasFollowingKeyframe:
              diamond.frame <
              lane.diamonds[lane.diamonds.length - 1]!.frame,
            properties: { [lane.property]: diamond.value },
            outgoing: diamond.interpolation,
          },
        })),
      })),
    ),
  };
}

/** Resolve all native timeline lanes once per project/element revision. */
export function buildNativeTimelineLaneProjectionMap(
  document: NativeProjectDocument | null,
  elements: readonly TimelineElement[],
): ReadonlyMap<string, NativeTimelineElementLaneProjection> {
  const projections = new Map<string, NativeTimelineElementLaneProjection>();
  if (!document) return projections;
  for (const element of elements) {
    const projection = nativeTimelinePropertyLanesForElement(document, element);
    // An empty native projection does not suppress still-unmigrated legacy
    // lanes. Native becomes authoritative for this clip once it owns a lane.
    if (!projection || projection.lanes.length === 0) continue;
    projections.set(element.key ?? element.id, projection);
  }
  return projections;
}

/** Count distinct rendered property groups, not individual scalar parameters. */
export function nativeTimelineLaneCounts(
  projections: ReadonlyMap<string, NativeTimelineElementLaneProjection>,
): ReadonlyMap<string, number> {
  return new Map(
    [...projections].map(([elementId, projection]) => [
      elementId,
      new Set(projection.lanes.map((lane) => lane.propertyGroup)).size,
    ]),
  );
}
