import type { NativeInterpolation, NativeParameterTrack } from "./nativeKeyframeTypes";
import type { NativeProjectDocument } from "./nativeProjectDocument";
import {
  resolveNativeClipSelection,
  type NativePropertyEditPlanFailure,
  type NativeSelectedElementReference,
} from "./nativePropertyEditPlan";

export type NativeTimelineProperty =
  | "x"
  | "y"
  | "z"
  | "rotation"
  | "rotationX"
  | "rotationY"
  | "scale"
  | "scaleX"
  | "scaleY"
  | "scaleZ"
  | "transformPerspective"
  | "opacity"
  | "width"
  | "height";

export type NativeTimelinePropertyGroupId =
  | "position"
  | "rotation"
  | "scale"
  | "opacity"
  | "size";

export interface NativeTimelineKeyframeDiamond {
  readonly id: string;
  readonly keyframeId: string;
  readonly animationId: string;
  readonly parameterId: string;
  readonly frame: number;
  readonly percentage: number;
  readonly value: number;
  readonly interpolation: NativeInterpolation;
}

export interface NativeTimelineKeyframeLane {
  readonly laneId: string;
  readonly animationId: string;
  readonly parameterId: string;
  readonly property: NativeTimelineProperty;
  readonly label: string;
  readonly diamonds: readonly NativeTimelineKeyframeDiamond[];
}

export interface NativeTimelineKeyframeGroup {
  readonly id: NativeTimelinePropertyGroupId;
  readonly label: string;
  readonly lanes: readonly NativeTimelineKeyframeLane[];
}

export type NativeTimelineKeyframeProjectionFailure =
  | NativePropertyEditPlanFailure
  | {
      readonly code: "keyframe-outside-clip";
      readonly message: string;
      readonly parameterId: string;
      readonly keyframeId: string;
    };

export type NativeTimelineKeyframeProjectionResult =
  | {
      readonly ok: true;
      readonly sequenceId: string;
      readonly trackId: string;
      readonly clipId: string;
      readonly clipStartFrame: number;
      readonly clipDurationFrames: number;
      readonly groups: readonly NativeTimelineKeyframeGroup[];
    }
  | { readonly ok: false; readonly failure: NativeTimelineKeyframeProjectionFailure };

interface PropertyDefinition {
  readonly parameterId: string;
  readonly property: NativeTimelineProperty;
  readonly label: string;
  readonly groupId: NativeTimelinePropertyGroupId;
}

interface GroupDefinition {
  readonly id: NativeTimelinePropertyGroupId;
  readonly label: string;
}

const GROUPS: readonly GroupDefinition[] = [
  { id: "position", label: "Position" },
  { id: "rotation", label: "Rotation" },
  { id: "scale", label: "Scale" },
  { id: "opacity", label: "Opacity" },
  { id: "size", label: "Size" },
];

const PROPERTIES: readonly PropertyDefinition[] = [
  { parameterId: "transform.position.x", property: "x", label: "X", groupId: "position" },
  { parameterId: "transform.position.y", property: "y", label: "Y", groupId: "position" },
  { parameterId: "transform.position.z", property: "z", label: "Z", groupId: "position" },
  {
    parameterId: "transform.rotation",
    property: "rotation",
    label: "Rotation",
    groupId: "rotation",
  },
  { parameterId: "transform.rotationX", property: "rotationX", label: "Rotate X", groupId: "rotation" },
  { parameterId: "transform.rotationY", property: "rotationY", label: "Rotate Y", groupId: "rotation" },
  {
    parameterId: "transform.perspective",
    property: "transformPerspective",
    label: "Perspective",
    groupId: "rotation",
  },
  { parameterId: "transform.scale", property: "scale", label: "Scale", groupId: "scale" },
  { parameterId: "transform.scaleX", property: "scaleX", label: "Scale X", groupId: "scale" },
  { parameterId: "transform.scaleY", property: "scaleY", label: "Scale Y", groupId: "scale" },
  { parameterId: "transform.scaleZ", property: "scaleZ", label: "Scale Z", groupId: "scale" },
  { parameterId: "visual.opacity", property: "opacity", label: "Opacity", groupId: "opacity" },
  { parameterId: "layout.width", property: "width", label: "Width", groupId: "size" },
  { parameterId: "layout.height", property: "height", label: "Height", groupId: "size" },
];

const propertyByParameterId = new Map(
  PROPERTIES.map((property, order) => [property.parameterId, { ...property, order }]),
);

const cloneInterpolation = (interpolation: NativeInterpolation): NativeInterpolation =>
  interpolation.type === "cubic-bezier"
    ? { type: interpolation.type, controlPoints: { ...interpolation.controlPoints } }
    : { type: interpolation.type };

/**
 * Create neutral timeline lanes from native parameter tracks. Timeline chrome
 * can consume this shape without importing the legacy tween runtime.
 */
export const projectNativeTimelineKeyframes = (
  document: NativeProjectDocument,
  identity: NativeSelectedElementReference,
): NativeTimelineKeyframeProjectionResult => {
  const resolution = resolveNativeClipSelection(document, identity);
  if (!resolution.ok) return { ok: false, failure: resolution.failure };
  const { clip, trackId } = resolution.located;

  const projectedTracks = clip.parameterTracks
    .flatMap((track) => {
      const property = propertyByParameterId.get(track.parameterId);
      if (!property || track.valueType !== "number") return [];
      return [{ track: track as NativeParameterTrack<"number">, property }];
    })
    .sort(
      (left, right) =>
        left.property.order - right.property.order || left.track.id.localeCompare(right.track.id),
    );

  for (const { track } of projectedTracks) {
    const outside = track.keyframes.find(
      (keyframe) => keyframe.frame < 0 || keyframe.frame >= clip.durationFrames,
    );
    if (outside) {
      return {
        ok: false,
        failure: {
          code: "keyframe-outside-clip",
          message: `Keyframe ${outside.id} is outside clip-local frame range`,
          parameterId: track.parameterId,
          keyframeId: outside.id,
        },
      };
    }
  }

  const lanesByGroup = new Map<NativeTimelinePropertyGroupId, NativeTimelineKeyframeLane[]>();
  for (const { track, property } of projectedTracks) {
    const diamonds: NativeTimelineKeyframeDiamond[] = track.keyframes
      .map((keyframe) => ({
        id: keyframe.id,
        keyframeId: keyframe.id,
        animationId: track.id,
        parameterId: track.parameterId,
        frame: keyframe.frame,
        percentage: (keyframe.frame / clip.durationFrames) * 100,
        value: keyframe.value,
        interpolation: cloneInterpolation(keyframe.outgoing),
      }))
      .sort((left, right) => left.frame - right.frame || left.keyframeId.localeCompare(right.keyframeId));
    const lanes = lanesByGroup.get(property.groupId) ?? [];
    lanes.push({
      laneId: track.id,
      animationId: track.id,
      parameterId: track.parameterId,
      property: property.property,
      label: property.label,
      diamonds,
    });
    lanesByGroup.set(property.groupId, lanes);
  }

  const groups = GROUPS.flatMap((group) => {
    const lanes = lanesByGroup.get(group.id);
    return lanes?.length ? [{ ...group, lanes }] : [];
  });
  return {
    ok: true,
    sequenceId: document.sequence.id,
    trackId,
    clipId: clip.id,
    clipStartFrame: clip.startFrame,
    clipDurationFrames: clip.durationFrames,
    groups,
  };
};
