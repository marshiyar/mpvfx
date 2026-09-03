import {
  validateRationalFrameRate,
  type NativeParameterTrack,
  type RationalFrameRate,
} from "./nativeKeyframeTypes";
import { evaluateNativeParameterTrack } from "./nativeKeyframeEvaluator";
import type {
  NativeProjectParameterAddress,
} from "./nativeProjectKeyframeCommands";
import type { NativeProjectAtomicPropertyCommand } from "./nativeProjectPropertyCommands";
import type { NativeProjectClip, NativeProjectDocument } from "./nativeProjectDocument";

export type NativeEditableProperty =
  | "x"
  | "y"
  | "z"
  | "rotation"
  | "rotationX"
  | "rotationY"
  | "rotationZ"
  | "scale"
  | "scaleX"
  | "scaleY"
  | "scaleZ"
  | "perspective"
  | "transformPerspective"
  | "opacity"
  | "autoAlpha"
  | "width"
  | "height";

export interface NativeSelectedElementReference {
  readonly id?: string | null;
  readonly hfId?: string | null;
  readonly sourceFile?: string | null;
  readonly selector?: string | null;
  readonly selectorIndex?: number | null;
  readonly attributes?: Readonly<Record<string, string | null | undefined>>;
  readonly dataset?: { readonly studioClipId?: string | null };
}

export interface NativeSelectionBounds {
  readonly width: number;
  readonly height: number;
}

export interface NativePropertyEditPlanRequest {
  readonly selectedElement: NativeSelectedElementReference;
  readonly playheadSeconds: number;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly selectionBounds?: NativeSelectionBounds;
  /** Measured pre-native values from the selected preview element. */
  readonly propertyBaselines?: Readonly<Partial<Record<NativeEditableProperty, number>>>;
  /** Explicit keyframe buttons always use `keyframe`. Ordinary inspector and
   * gesture edits use `edit` and follow the auto-keyframe preference. */
  readonly intent?: "edit" | "keyframe";
  readonly autoKeyframeEnabled?: boolean;
}

export type NativePropertyEditPlanFailureCode =
  | "missing-selection-id"
  | "clip-not-found"
  | "ambiguous-clip"
  | "invalid-playhead"
  | "playhead-outside-clip"
  | "empty-property-set"
  | "unsupported-property"
  | "nonfinite-value"
  | "missing-selection-bounds"
  | "duplicate-parameter";

export interface NativePropertyEditPlanFailure {
  readonly code: NativePropertyEditPlanFailureCode;
  readonly message: string;
  readonly property?: string;
}

export type NativePropertyEditPlanResult =
  | {
      readonly ok: true;
      readonly clipId: string;
      readonly projectFrame: number;
      readonly clipLocalFrame: number;
      readonly command: {
        readonly type: "batch";
        readonly commands: readonly NativeProjectAtomicPropertyCommand[];
      };
    }
  | { readonly ok: false; readonly failure: NativePropertyEditPlanFailure };

interface LocatedClip {
  readonly trackId: string;
  readonly clip: NativeProjectClip;
}

export type NativeClipSelectionResolution =
  | { readonly ok: true; readonly located: LocatedClip }
  | { readonly ok: false; readonly failure: NativePropertyEditPlanFailure };

interface PropertyDefinition {
  readonly parameterId: string;
  readonly baseline: (bounds?: NativeSelectionBounds) => number | null;
}

const PROPERTY_ORDER: readonly NativeEditableProperty[] = [
  "x",
  "y",
  "z",
  "rotation",
  "rotationX",
  "rotationY",
  "rotationZ",
  "scale",
  "scaleX",
  "scaleY",
  "scaleZ",
  "perspective",
  "transformPerspective",
  "opacity",
  "autoAlpha",
  "width",
  "height",
];

const constantBaseline = (value: number) => () => value;
const PROPERTY_DEFINITIONS: Readonly<Record<NativeEditableProperty, PropertyDefinition>> = {
  x: { parameterId: "transform.position.x", baseline: constantBaseline(0) },
  y: { parameterId: "transform.position.y", baseline: constantBaseline(0) },
  z: { parameterId: "transform.position.z", baseline: constantBaseline(0) },
  rotation: { parameterId: "transform.rotation", baseline: constantBaseline(0) },
  rotationX: { parameterId: "transform.rotationX", baseline: constantBaseline(0) },
  rotationY: { parameterId: "transform.rotationY", baseline: constantBaseline(0) },
  rotationZ: { parameterId: "transform.rotation", baseline: constantBaseline(0) },
  scale: { parameterId: "transform.scale", baseline: constantBaseline(1) },
  scaleX: { parameterId: "transform.scaleX", baseline: constantBaseline(1) },
  scaleY: { parameterId: "transform.scaleY", baseline: constantBaseline(1) },
  scaleZ: { parameterId: "transform.scaleZ", baseline: constantBaseline(1) },
  perspective: { parameterId: "transform.perspective", baseline: constantBaseline(0) },
  transformPerspective: { parameterId: "transform.perspective", baseline: constantBaseline(0) },
  opacity: { parameterId: "visual.opacity", baseline: constantBaseline(1) },
  autoAlpha: { parameterId: "visual.opacity", baseline: constantBaseline(1) },
  width: { parameterId: "layout.width", baseline: (bounds) => bounds?.width ?? null },
  height: { parameterId: "layout.height", baseline: (bounds) => bounds?.height ?? null },
};

const failure = (
  code: NativePropertyEditPlanFailureCode,
  message: string,
  property?: string,
): NativePropertyEditPlanResult => ({
  ok: false,
  failure: { code, message, ...(property ? { property } : {}) },
});

/** Quantize editor time exactly as native preview and export address project frames. */
export const projectFrameFromSeconds = (
  seconds: number,
  frameRate: RationalFrameRate,
): number => {
  if (!Number.isFinite(seconds)) {
    throw new TypeError("Playhead seconds must be finite");
  }
  if (seconds < 0) {
    throw new RangeError("Playhead seconds must not be negative");
  }
  const validated = validateRationalFrameRate(frameRate);
  return Math.floor((seconds * validated.numerator) / validated.denominator + 1e-9);
};

const explicitSelectedClipId = (
  selectedElement: NativeSelectedElementReference,
): string | null | undefined => {
  const attributeValue = selectedElement.attributes?.["data-studio-clip-id"];
  if (typeof attributeValue === "string") return attributeValue;
  if (typeof selectedElement.dataset?.studioClipId === "string") {
    return selectedElement.dataset.studioClipId;
  }
  return undefined;
};

const findClip = (document: NativeProjectDocument, clipId: string): LocatedClip[] => {
  const matches: LocatedClip[] = [];
  for (const track of document.sequence.tracks) {
    for (const clip of track.clips) {
      if (clip.id === clipId) matches.push({ trackId: track.id, clip });
    }
  }
  return matches;
};

const resolutionFailure = (
  code: NativePropertyEditPlanFailureCode,
  message: string,
): NativeClipSelectionResolution => ({ ok: false, failure: { code, message } });

/** Resolve one selected preview node without making DOM identity canonical. */
export const resolveNativeClipSelection = (
  document: NativeProjectDocument,
  selectedElement: NativeSelectedElementReference,
): NativeClipSelectionResolution => {
  const explicitClipId = explicitSelectedClipId(selectedElement);
  if (typeof explicitClipId === "string") {
    if (explicitClipId.length === 0) {
      return resolutionFailure(
        "missing-selection-id",
        "The selected element has an empty native clip identity",
      );
    }
    const explicitMatches = findClip(document, explicitClipId);
    if (explicitMatches.length === 1) return { ok: true, located: explicitMatches[0] };
    if (explicitMatches.length > 1) {
      return resolutionFailure(
        "ambiguous-clip",
        `More than one native clip exactly matches ${explicitClipId}`,
      );
    }
    return resolutionFailure("clip-not-found", `No native clip exactly matches ${explicitClipId}`);
  }

  const id = typeof selectedElement.id === "string" && selectedElement.id.length > 0
    ? selectedElement.id
    : null;
  const hfId = typeof selectedElement.hfId === "string" && selectedElement.hfId.length > 0
    ? selectedElement.hfId
    : null;
  const sourceFile =
    typeof selectedElement.sourceFile === "string" && selectedElement.sourceFile.length > 0
      ? selectedElement.sourceFile
      : null;
  const selector =
    typeof selectedElement.selector === "string" && selectedElement.selector.length > 0
      ? selectedElement.selector
      : null;
  const selectorIndex =
    typeof selectedElement.selectorIndex === "number" &&
    Number.isInteger(selectedElement.selectorIndex) &&
    selectedElement.selectorIndex >= 0
      ? selectedElement.selectorIndex
      : 0;

  if (!id && !hfId && !selector) {
    return resolutionFailure(
      "missing-selection-id",
      "The selected element has no exact native clip or compatibility identity",
    );
  }

  if (sourceFile) {
    const bindingMatches = new Map<string, LocatedClip>();
    for (const track of document.sequence.tracks) {
      for (const clip of track.clips) {
        const binding = clip.binding;
        if (!binding || binding.sourceFile !== sourceFile) continue;
        const matchesDomId = Boolean(id && binding.domId === id);
        const matchesHfId = Boolean(hfId && binding.hfId === hfId);
        const matchesSelector = Boolean(
          selector &&
            binding.selector === selector &&
            (binding.selectorIndex ?? 0) === selectorIndex,
        );
        if (matchesDomId || matchesHfId || matchesSelector) {
          bindingMatches.set(clip.id, { trackId: track.id, clip });
        }
      }
    }
    if (bindingMatches.size === 1) {
      return { ok: true, located: [...bindingMatches.values()][0] };
    }
    if (bindingMatches.size > 1) {
      return resolutionFailure(
        "ambiguous-clip",
        "Selection identifiers resolve to more than one scoped native clip binding",
      );
    }
  }

  if (!sourceFile) {
    const unscopedMatches = new Map<string, LocatedClip>();
    for (const track of document.sequence.tracks) {
      for (const clip of track.clips) {
        const binding = clip.binding;
        if (!binding) continue;
        const matchesDomId = Boolean(id && binding.domId === id);
        const matchesHfId = Boolean(hfId && binding.hfId === hfId);
        const matchesSelector = Boolean(
          selector &&
            binding.selector === selector &&
            (binding.selectorIndex ?? 0) === selectorIndex,
        );
        if (matchesDomId || matchesHfId || matchesSelector) {
          unscopedMatches.set(clip.id, { trackId: track.id, clip });
        }
      }
    }

    if (id) {
      const directMatches = findClip(document, id);
      if (directMatches.length > 1) {
        return resolutionFailure(
          "ambiguous-clip",
          `More than one native clip exactly matches ${id}`,
        );
      }
      if (directMatches.length === 1) {
        unscopedMatches.set(directMatches[0].clip.id, directMatches[0]);
      }
    }

    if (unscopedMatches.size === 1) {
      return { ok: true, located: [...unscopedMatches.values()][0] };
    }
    if (unscopedMatches.size > 1) {
      return resolutionFailure(
        "ambiguous-clip",
        "Selection identifiers resolve to more than one unscoped native clip binding",
      );
    }
  }

  if (id) {
    const directMatches = findClip(document, id);
    if (directMatches.length === 1) return { ok: true, located: directMatches[0] };
    if (directMatches.length > 1) {
      return resolutionFailure(
        "ambiguous-clip",
        `More than one native clip exactly matches ${id}`,
      );
    }
  }
  return resolutionFailure(
    "clip-not-found",
    "No native clip exactly matches the selected element or its scoped compatibility binding",
  );
};

const validBounds = (bounds: NativeSelectionBounds | undefined): bounds is NativeSelectionBounds =>
  Boolean(
    bounds &&
      Number.isFinite(bounds.width) &&
      bounds.width > 0 &&
      Number.isFinite(bounds.height) &&
      bounds.height > 0,
  );

export const planNativePropertyEdit = (
  document: NativeProjectDocument,
  request: NativePropertyEditPlanRequest,
): NativePropertyEditPlanResult => {
  const resolution = resolveNativeClipSelection(document, request.selectedElement);
  if (!resolution.ok) return { ok: false, failure: resolution.failure };
  const located = resolution.located;

  let projectFrame: number;
  try {
    projectFrame = projectFrameFromSeconds(request.playheadSeconds, document.frameRate);
  } catch (error) {
    return failure(
      "invalid-playhead",
      error instanceof Error ? error.message : "The playhead time is invalid",
    );
  }
  const clipLocalFrame = projectFrame - located.clip.startFrame;
  if (clipLocalFrame < 0 || clipLocalFrame >= located.clip.durationFrames) {
    return failure(
      "playhead-outside-clip",
      `Project frame ${projectFrame} is outside clip ${located.clip.id}`,
    );
  }

  const propertyNames = Object.keys(request.properties);
  if (propertyNames.length === 0) {
    return failure("empty-property-set", "At least one property edit is required");
  }
  const supported = new Set<string>(PROPERTY_ORDER);
  const unsupported = propertyNames.find((property) => !supported.has(property));
  if (unsupported) {
    return failure(
      "unsupported-property",
      `Property ${unsupported} is not supported by native keyframes`,
      unsupported,
    );
  }
  for (const property of propertyNames) {
    if (typeof request.properties[property] !== "number" || !Number.isFinite(request.properties[property])) {
      return failure(
        "nonfinite-value",
        `Property ${property} must have a finite numeric value`,
        property,
      );
    }
  }
  const writesKeyframe =
    request.intent !== "edit" || request.autoKeyframeEnabled !== false;
  if (
    writesKeyframe &&
    (Object.hasOwn(request.properties, "width") || Object.hasOwn(request.properties, "height")) &&
    !validBounds(request.selectionBounds)
  ) {
    return failure(
      "missing-selection-bounds",
      "Finite positive selection bounds are required to keyframe width or height",
    );
  }

  const commands: NativeProjectAtomicPropertyCommand[] = [];
  const parameterIds = new Set<string>();
  for (const property of PROPERTY_ORDER) {
    if (!Object.hasOwn(request.properties, property)) continue;
    const definition = PROPERTY_DEFINITIONS[property];
    if (parameterIds.has(definition.parameterId)) {
      return failure(
        "duplicate-parameter",
        `Properties target native parameter ${definition.parameterId} more than once`,
        property,
      );
    }
    parameterIds.add(definition.parameterId);
    const address: NativeProjectParameterAddress = {
      sequenceId: document.sequence.id,
      trackId: located.trackId,
      clipId: located.clip.id,
      parameterId: definition.parameterId,
    };
    const value = request.properties[property] as number;
    const parameterTrack = located.clip.parameterTracks.find(
      (track) => track.parameterId === definition.parameterId,
    );

    if (writesKeyframe) {
      const persistedStatic = located.clip.staticParameters?.[definition.parameterId];
      const measuredBaseline = request.propertyBaselines?.[property];
      const baseline =
        typeof persistedStatic === "number"
          ? persistedStatic
          : typeof measuredBaseline === "number" && Number.isFinite(measuredBaseline)
            ? measuredBaseline
            : definition.baseline(request.selectionBounds);
      if (baseline == null) {
        return failure(
          "missing-selection-bounds",
          `Property ${property} requires a selection-bound baseline`,
          property,
        );
      }
      commands.push({
        type: "upsert",
        address,
        valueType: "number",
        frame: clipLocalFrame,
        value,
        baselineValue: baseline,
      });
      continue;
    }

    if (!parameterTrack) {
      commands.push({ type: "set-static", address, value });
      continue;
    }
    if (parameterTrack.valueType !== "number") {
      return failure(
        "unsupported-property",
        `Property ${property} is bound to a non-numeric native parameter`,
        property,
      );
    }
    const exactKeyframe = parameterTrack.keyframes.find(
      (keyframe) => keyframe.frame === clipLocalFrame,
    );
    if (exactKeyframe) {
      commands.push({
        type: "update-value",
        address,
        frame: clipLocalFrame,
        value,
      });
      continue;
    }
    const evaluated = evaluateNativeParameterTrack(
      parameterTrack as NativeParameterTrack<"number">,
      clipLocalFrame,
    );
    commands.push({
      type: "offset-track",
      address,
      delta: value - evaluated,
    });
  }

  return {
    ok: true,
    clipId: located.clip.id,
    projectFrame,
    clipLocalFrame,
    command: { type: "batch", commands },
  };
};
