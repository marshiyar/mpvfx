import {
  HF_AUDIO_AUTOMATION_ATTR,
  parseAutomation,
  serializeAutomation,
  type HfAutomation,
  type HfAutomationLane,
} from "@hyperframes/core/audio-automation";
import {
  applyPatchByTarget,
  readAttributeByTarget,
  type PatchTarget,
} from "./sourcePatcher";

/** Keep the original interpolation domain; visibility is the clip's range. */
function splitLane(
  lane: Readonly<HfAutomationLane>,
  splitLocalSeconds: number,
): { left: HfAutomationLane; right: HfAutomationLane } {
  return {
    left: {
      target: lane.target,
      points: lane.points.map((point) => ({ ...point })),
    },
    right: {
      target: lane.target,
      points: lane.points.map((point) => ({
        ...point,
        t: point.t - splitLocalSeconds,
      })),
    },
  };
}

/** Shift the animation origin when trimming In; never crop or stretch curves. */
export function shiftAudioAutomationInHtml(
  html: string,
  target: PatchTarget,
  deltaSeconds: number,
): string {
  if (deltaSeconds === 0) return html;
  const raw = readAttributeByTarget(html, target, HF_AUDIO_AUTOMATION_ATTR);
  if (raw === undefined) return html;
  const automation = parseAutomation(raw);
  const shifted = {
    ...automation,
    lanes: automation.lanes.map((lane) => splitLane(lane, deltaSeconds).right),
  };
  return applyPatchByTarget(html, target, {
    type: "attribute",
    property: HF_AUDIO_AUTOMATION_ATTR,
    value: serializeAutomation(shifted),
  });
}

export function splitAudioAutomation(
  automation: Readonly<HfAutomation>,
  splitLocalSeconds: number,
): { left: HfAutomation; right: HfAutomation } {
  if (!Number.isFinite(splitLocalSeconds) || splitLocalSeconds <= 0) {
    throw new Error("Audio automation split time must be a positive clip-local second");
  }
  const lanes = automation.lanes.map((lane) => splitLane(lane, splitLocalSeconds));
  return {
    left: { version: automation.version, lanes: lanes.map(({ left }) => left) },
    right: { version: automation.version, lanes: lanes.map(({ right }) => right) },
  };
}

/**
 * Preserve both complete envelopes and rebase the right clip-local origin.
 * Parsing happens before either patch, so unreadable automation rejects the
 * surrounding native file transaction instead of saving two corrupted lanes.
 */
export function splitAudioAutomationInHtml(
  html: string,
  leftTarget: PatchTarget,
  rightTarget: PatchTarget,
  splitLocalSeconds: number,
): string {
  const raw = readAttributeByTarget(html, leftTarget, HF_AUDIO_AUTOMATION_ATTR);
  if (raw === undefined) return html;

  const split = splitAudioAutomation(parseAutomation(raw), splitLocalSeconds);
  let patched = applyPatchByTarget(html, leftTarget, {
    type: "attribute",
    property: HF_AUDIO_AUTOMATION_ATTR,
    value: serializeAutomation(split.left),
  });
  patched = applyPatchByTarget(patched, rightTarget, {
    type: "attribute",
    property: HF_AUDIO_AUTOMATION_ATTR,
    value: serializeAutomation(split.right),
  });
  return patched;
}
