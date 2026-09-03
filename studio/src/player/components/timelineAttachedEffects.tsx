import { memo } from "react";
import {
  hasHfColorGradingAuthoredValues,
  normalizeHfColorGrading,
} from "@hyperframes/core/color-grading";
import type { NativeClipEffect, NativeProjectDocument } from "../../project/nativeProjectDocument";
import { resolveNativeClipSelection } from "../../project/nativePropertyEditPlan";
import type { TimelineElement } from "../store/playerStore";
import { elementFxChain } from "./automationLaneData";
import { timelineNestedStripColor } from "./timelineNestedStrip";
import { EFFECT_STRIP_H, TRACK_H } from "./timelineLayout";

export interface TimelineAttachedEffect {
  id: string;
  label: string;
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function hasColorGrading(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return hasHfColorGradingAuthoredValues(normalizeHfColorGrading(JSON.parse(raw)));
  } catch {
    return false;
  }
}

export function timelineAttachedEffects(
  element: TimelineElement,
  nativeEffects: readonly NativeClipEffect[] = [],
): TimelineAttachedEffect[] {
  const strips: TimelineAttachedEffect[] = [];
  if (hasColorGrading(element.colorGrading)) {
    strips.push({ id: "color-grading", label: "Color" });
  }
  for (const [index, node] of (elementFxChain(element)?.nodes ?? []).entries()) {
    if (node.enabled === false) continue;
    strips.push({
      id: `audio:${node.id ?? `${node.type}:${index}`}`,
      label: titleCase(node.type),
    });
  }
  for (const effect of nativeEffects) {
    if (!effect.enabled) continue;
    strips.push({ id: `native:${effect.id}`, label: titleCase(effect.effectId) });
  }
  return strips;
}

export function buildNativeTimelineEffectMap(
  document: NativeProjectDocument | null,
  elements: readonly TimelineElement[],
): ReadonlyMap<string, readonly NativeClipEffect[]> {
  const result = new Map<string, readonly NativeClipEffect[]>();
  if (!document) return result;
  for (const element of elements) {
    const resolution = resolveNativeClipSelection(document, element);
    if (!resolution.ok || resolution.located.clip.effects.length === 0) continue;
    result.set(element.key ?? element.id, resolution.located.clip.effects);
  }
  return result;
}

export function timelineAttachedEffectLaneCount(
  elements: readonly TimelineElement[],
  nativeEffectMap: ReadonlyMap<string, readonly NativeClipEffect[]> = new Map(),
): number {
  return elements.reduce(
    (maximum, element) =>
      Math.max(
        maximum,
        timelineAttachedEffects(element, nativeEffectMap.get(element.key ?? element.id)).length,
      ),
    0,
  );
}

export const TimelineAttachedEffectStrips = memo(function TimelineAttachedEffectStrips({
  element,
  nativeEffects,
  pps,
}: {
  element: TimelineElement;
  nativeEffects?: readonly NativeClipEffect[];
  pps: number;
}) {
  const effects = timelineAttachedEffects(element, nativeEffects);
  if (effects.length === 0) return null;
  return (
    <div
      aria-label={`Effects applied to ${element.label ?? element.id}`}
      data-timeline-effect-strips="true"
      data-effect-owner-id={element.key ?? element.id}
      className="pointer-events-none absolute z-[6] overflow-hidden"
      style={{
        left: element.start * pps,
        top: TRACK_H,
        width: Math.max(element.duration * pps, 4),
        height: effects.length * EFFECT_STRIP_H,
      }}
    >
      {effects.map((effect, index) => {
        const color = timelineNestedStripColor(effect.id);
        return (
          <div
            key={effect.id}
            data-timeline-effect-strip={effect.id}
            title={effect.label}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: index * EFFECT_STRIP_H,
              height: EFFECT_STRIP_H,
              background: color.edge,
              opacity: 1,
              color: "#09110E",
              fontSize: 10,
              fontWeight: 700,
              lineHeight: `${EFFECT_STRIP_H}px`,
              paddingInline: 6,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {effect.label}
          </div>
        );
      })}
    </div>
  );
});
