import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import { classifyPropertyGroup } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "../../canvas/domEditingTypes";
import type { SetPatchProps } from "./gsapRuntimePatch";
import { isInstantHold, tweenTargetsElement, writeTargetSelector } from "./gsapShared";
import { GsapEditBlockedError } from "./gsapEditOutcome";
import type { CommitMutation, CommitMutationCall } from "./gsapScriptCommitTypes";

/**
 * Auto-keyframe a just-updated static `set`: if the element is already animated
 * (its clip carries keyframes on another tween), convert the set to keyframes so
 * subsequent edits at other playheads interpolate — matching the drag / resize /
 * rotate UX. Purely static elements (no other keyframes) are left as a set.
 */
async function maybeAutoKeyframeSet(
  selection: DomEditSelection,
  setAnim: GsapAnimation,
  animations: GsapAnimation[],
  commit: CommitMutation,
): Promise<void> {
  const animatedTween = animations.find((a) => a.keyframes && a.id !== setAnim.id);
  if (!animatedTween) return;
  await commit(
    selection,
    {
      type: "convert-to-keyframes",
      animationId: setAnim.id,
      duration: animatedTween.duration ?? 1,
    },
    { label: "Keyframe 3D transform", softReload: true },
  );
}

type Commit = CommitMutation;

/** Undo-history label for a static-set commit, from the group it writes. */
const STATIC_SET_LABELS: Partial<Record<ReturnType<typeof classifyPropertyGroup>, string>> = {
  position: "Move layer",
  scale: "Resize layer",
  size: "Resize layer",
  rotation: "Rotate layer",
  visual: "Set opacity",
  other: "Set 3D transform",
};

function staticSetLabel(propEntries: [string, number | string][]): string {
  const groups = new Set(propEntries.map(([k]) => classifyPropertyGroup(k)));
  const only = groups.size === 1 ? [...groups][0] : undefined;
  return (only && STATIC_SET_LABELS[only]) || "Set properties";
}

export function identityBaselineForProperty(property: string, editedValue: number | string): number | string {
  if (
    property === "opacity" ||
    property === "autoAlpha" ||
    property === "scale" ||
    property === "scaleX" ||
    property === "scaleY"
  ) {
    return 1;
  }
  return typeof editedValue === "number" ? 0 : editedValue;
}

/** Merge ALL props into the static `set` in ONE commit (value-only, instant), then
 *  auto-keyframe. One mutation — a per-property loop would shift the set's
 *  group-derived id mid-way (e.g. reset adding `scale` to a rotation set), 404-ing
 *  the next update. */
export async function commitSetProps(
  selection: DomEditSelection,
  setAnim: GsapAnimation,
  propEntries: [string, number | string][],
  selector: string | null,
  animations: GsapAnimation[],
  commit: Commit,
): Promise<void> {
  const call = buildSetPropsCall(selection, setAnim, propEntries, selector);
  await commit(call.selection, call.mutation, call.options);
  await maybeAutoKeyframeSet(selection, setAnim, animations, commit);
}

function buildSetPropsCall(
  selection: DomEditSelection,
  setAnim: GsapAnimation,
  propEntries: [string, number | string][],
  selector: string | null,
): CommitMutationCall {
  const properties = Object.fromEntries(propEntries);
  const numericProps: SetPatchProps = {};
  for (const [k, v] of propEntries) {
    if (typeof v === "number") numericProps[k as keyof SetPatchProps] = v;
  }
  const instantPatch =
    selector && Object.keys(numericProps).length > 0
      ? {
          selector,
          change: {
            kind: (setAnim.global ? "global-set" : "set") as "set" | "global-set",
            props: numericProps,
          },
        }
      : undefined;
  return {
    selection,
    mutation: { type: "update-properties", animationId: setAnim.id, properties },
    options: {
      label: staticSetLabel(propEntries),
      softReload: true,
      ...(instantPatch ? { instantPatch } : {}),
    },
  };
}

/**
 * Static element (no keyframes on ANY of its tweens): persist the 3D props as a
 * `tl.set` — NEVER keyframes. Mirrors manual drag / resize / rotate, which `tl.set`
 * a static element instead of animating it. Updates an existing same-group static
 * hold in place, or creates a dedicated `set` at position 0 when the element has none.
 */
export async function commitStaticSet(
  selection: DomEditSelection,
  propEntries: [string, number | string][],
  selector: string | null,
  animations: GsapAnimation[],
  commit: Commit,
): Promise<void> {
  const calls = planStaticSetCalls(selection, propEntries, selector, animations);
  const only = calls[0];
  if (!only) return;
  if (calls.length === 1) {
    await commit(only.selection, only.mutation, only.options);
    return;
  }
  if (!commit.batch) {
    throw new Error("Atomic GSAP property batch is unavailable");
  }
  await commit.batch(calls, {
    label: staticSetLabel(propEntries),
    softReload: true,
  });
}

function groupStaticSetEntries(
  propEntries: [string, number | string][],
): Map<string, [string, number | string][]> {
  // One commit per PROPERTY GROUP, each into a static write that owns that group —
  // never a live tween, and never a foreign-group write (a width edit used to
  // merge into the element's position set, producing a mixed write the split
  // machinery exists to prevent). Within a group everything batches into ONE
  // commit: a write's id is group-derived, so a per-prop loop would shift the id
  // mid-way and 404 the next update.
  const byGroup = new Map<string, [string, number | string][]>();
  for (const entry of propEntries) {
    const group = classifyPropertyGroup(entry[0]);
    const batch = byGroup.get(group) ?? [];
    batch.push(entry);
    byGroup.set(group, batch);
  }
  return byGroup;
}

function planStaticSetCalls(
  selection: DomEditSelection,
  propEntries: [string, number | string][],
  selector: string | null,
  animations: GsapAnimation[],
): CommitMutationCall[] {
  const byGroup = groupStaticSetEntries(propEntries);
  const staticWrites = selector
    ? animations.filter(
        (a) =>
          isInstantHold(a) && tweenTargetsElement(a.targetSelector, selector, selection.element),
      )
    : [];
  // Resolve every group's target BEFORE committing anything, and coalesce
  // groups that land on the SAME write into one commit: the snapshot is captured
  // once, so if two groups resolved to one legacy mixed write, a first
  // commit could re-shape it server-side and leave the second chasing a stale
  // id (404 on legacy pre-split files).
  const byTargetWrite = new Map<GsapAnimation, [string, number | string][]>();
  const newSetBatches: [string, number | string][][] = [];
  for (const [group, batch] of byGroup) {
    const existingWrite = findGroupOwningStaticWrite(staticWrites, group);
    if (existingWrite) {
      byTargetWrite.set(existingWrite, [...(byTargetWrite.get(existingWrite) ?? []), ...batch]);
    } else {
      newSetBatches.push(batch);
    }
  }
  return [
    ...[...byTargetWrite].map(([targetWrite, batch]) =>
      buildSetPropsCall(selection, targetWrite, batch, selector),
    ),
    ...newSetBatches.map((batch) => buildGlobalStaticSetCall(selection, batch)),
  ];
}

/**
 * The static write that owns a property group: one already dedicated to the
 * group wins; else a mixed write that already carries a property of the group
 * (merging same-group values there beats spawning a second writer for the channel).
 */
function findGroupOwningStaticWrite(
  staticWrites: GsapAnimation[],
  group: string,
): GsapAnimation | undefined {
  return (
    staticWrites.find((a) => a.propertyGroup === group) ??
    staticWrites.find((a) =>
      Object.keys(a.properties).some((k) => classifyPropertyGroup(k) === group),
    )
  );
}

/**
 * Base `gsap.set` (off-timeline) — a static hold with no 0% keyframe marker, so
 * adjusting a 3D transform on a non-keyframed element doesn't drop a keyframe on
 * the timeline (matches the manual-drag UX). The global-set instant patch applies
 * it straight to the element so the first edit shows with no soft-reload flash.
 */
function buildGlobalStaticSetCall(
  selection: DomEditSelection,
  batch: [string, number | string][],
): CommitMutationCall {
  const numericProps: SetPatchProps = {};
  for (const [k, v] of batch) {
    if (typeof v === "number") numericProps[k as keyof SetPatchProps] = v;
  }
  // A brand-new write, so it must address ONE element: the selection's own
  // selector is the bare class an id-less element yields, which would hold every
  // sibling. No one-element form means no write at all (see writeTargetSelector).
  const target = writeTargetSelector(selection);
  if (!target) throw new GsapEditBlockedError("no-selector");
  return {
    selection,
    mutation: {
      type: "add",
      targetSelector: target,
      method: "set",
      position: 0,
      properties: Object.fromEntries(batch),
      global: true,
    },
    options: {
      label: staticSetLabel(batch),
      softReload: true,
      ...(Object.keys(numericProps).length > 0
        ? {
            instantPatch: {
              selector: target,
              change: { kind: "global-set" as const, props: numericProps },
            },
          }
        : {}),
    },
  };
}
