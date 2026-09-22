import type { NativeProjectDocument } from "../../project/nativeProjectDocument";
import {
  projectNativeTimelineKeyframes,
  type NativeTimelinePropertyGroupId,
} from "../../project/nativeTimelineKeyframeProjection";
import type { TimelineElement } from "../store/playerStore";
import type { NativeTimelinePropertyLane } from "./TimelinePropertyLanes";
import type { NativeTrackHeaderSource } from "./trackHeaderLaneState";

const TIMELINE_GROUP: Readonly<
  Record<
    NativeTimelinePropertyGroupId,
    NativeTimelinePropertyLane["propertyGroup"]
  >
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
    lanes: [
      ...result.groups.flatMap((group) =>
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
                clip.parameterTracks
                  .find((track) => track.parameterId === lane.parameterId)
                  ?.keyframes.some((key) => key.frame > diamond.frame) ?? false,
              properties: { [lane.property]: diamond.value },
              outgoing: diamond.interpolation,
            },
          })),
        })),
      ),
      ...Object.keys(clip.staticParameters ?? {}).flatMap((parameterId) => {
        const group = parameterId.startsWith("transform.position")
          ? "position"
          : parameterId.startsWith("transform.rotation") ||
              parameterId === "transform.perspective"
            ? "rotation"
            : parameterId.startsWith("transform.scale")
              ? "scale"
              : parameterId.includes("opacity") ||
                  parameterId === "visual.autoAlpha"
                ? "visual"
                : parameterId.startsWith("layout.")
                  ? "size"
                  : null;
        if (
          !group ||
          result.groups.some(
            (candidate) => TIMELINE_GROUP[candidate.id] === group,
          )
        )
          return [];
        // An authored static value also owns the property. Empty ownership lanes
        // suppress obsolete script diamonds without inventing animated keyframes.
        return [
          {
            id: `native-static:${clip.id}:${parameterId}`,
            propertyGroup: group as NativeTimelinePropertyLane["propertyGroup"],
            keyframes: [],
          },
        ];
      }),
    ],
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
      new Set(
        projection.lanes
          .filter((lane) => lane.keyframes.length > 0)
          .map((lane) => lane.propertyGroup),
      ).size,
    ]),
  );
}
