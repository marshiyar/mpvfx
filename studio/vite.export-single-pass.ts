import {
  CANVAS_DIMENSIONS,
  checkOutputResolutionCompatibility,
  type CanvasResolution,
} from "@hyperframes/parsers";

export interface ExportDimensions {
  width: number;
  height: number;
}

export interface SinglePassExportDimensionInput {
  authored: ExportDimensions;
  requested: ExportDimensions;
}

export type SinglePassExportDimensionPlan =
  | {
      resizeRequired: false;
      outputResolution?: CanvasResolution;
    }
  | {
      resizeRequired: true;
    };

function presetForExactDimensions(
  dimensions: ExportDimensions,
): CanvasResolution | undefined {
  return (Object.keys(CANVAS_DIMENSIONS) as CanvasResolution[]).find((preset) => {
    const candidate = CANVAS_DIMENSIONS[preset];
    return candidate.width === dimensions.width && candidate.height === dimensions.height;
  });
}

/**
 * Prefer producer's supported integer-scale preset path so a compatible exact
 * export can be rendered at its final size instead of encoded and resized a
 * second time. Exact targets outside that contract stay on the resize path.
 */
export function planSinglePassExportDimensions({
  authored,
  requested,
}: SinglePassExportDimensionInput): SinglePassExportDimensionPlan {
  if (authored.width === requested.width && authored.height === requested.height) {
    return { resizeRequired: false };
  }

  const outputResolution = presetForExactDimensions(requested);
  if (!outputResolution) {
    return { resizeRequired: true };
  }

  const compatibility = checkOutputResolutionCompatibility({
    compositionWidth: authored.width,
    compositionHeight: authored.height,
    outputResolution,
  });

  if (!compatibility.ok) {
    return { resizeRequired: true };
  }

  return { resizeRequired: false, outputResolution };
}
