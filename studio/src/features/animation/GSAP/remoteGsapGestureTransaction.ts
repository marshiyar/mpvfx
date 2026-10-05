import { parseHTML } from "linkedom";
import { parseGsapScriptAcorn } from "@hyperframes/core/gsap-parser-acorn";
import type { PreviewElementState, PreviewGsapObservation } from "../../../../shared/preview/agentProtocol";
import { serializeStudioFileMutation } from "../../history/studioFileMutationCoordinator";
import { commitNativeTimelineFileSnapshots } from "../../project/nativeTimelineTransactionCommit";
import { assertSameSelection, countMatchedRemoteGsapTargets, resolveSourceNode,
  type RemoteGsapSourceDeps } from "./remoteGsapSourceTransaction";

export type RemoteGsapGesture =
  | { mode: "move"; delta: { x: number; y: number } }
  | { mode: "resize"; width: number; height: number }
  | { mode: "rotate"; deltaDegrees: number };

const pixels = (value: string): number | null => {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))px$/.exec(value.trim());
  const number = match ? Number(match[1]) : NaN;
  return Number.isFinite(number) && Math.abs(number) <= 100_000 ? number : null;
};

const degrees = (value: string): number | null => {
  if (!value) return 0;
  const match = /^(-?(?:\d+\.?\d*|\.\d+))deg$/.exec(value.trim());
  const number = match ? Number(match[1]) : NaN;
  return Number.isFinite(number) && Math.abs(number) <= 3600 ? number : null;
};

const clean = (value: number): number => Math.round(value * 1000) / 1000;

function assertFlatAncestry(state: PreviewElementState, ancestors: readonly PreviewElementState[]): void {
  let parent = state.parent;
  if (ancestors.length > 16) throw new Error("The layer has too many transformed ancestors to edit safely");
  for (const ancestor of ancestors) {
    if (!parent || ancestor.handle !== parent || ancestor.sourceFile !== state.sourceFile ||
        ancestor.compositionPath !== state.compositionPath ||
        !["", "none"].includes(ancestor.computedStyles.transform ?? "none")) {
      throw new Error("The layer's parent transform cannot be mapped to source geometry");
    }
    parent = ancestor.parent;
  }
  if (parent !== null) throw new Error("The layer's full parent geometry is unavailable");
}

function assertRuntimeCompatible(observation: PreviewGsapObservation, gesture: RemoteGsapGesture): void {
  const blocked = blockedChannels(gesture);
  if (observation.tweens.some(tween => !tween.complete || tween.motionPath ||
      blocked.some(channel => channel in tween.properties ||
        tween.keyframes?.some(frame => channel in frame.properties)))) {
    throw new Error("This animated geometry needs the authored keyframe editor");
  }
}

function blockedChannels(gesture: RemoteGsapGesture): string[] {
  return gesture.mode === "move" ? ["left", "top", "xPercent", "yPercent"] :
    gesture.mode === "resize" ? ["width", "height", "scale", "scaleX", "scaleY"] :
    ["x", "y", "left", "top", "rotation", "rotationX", "rotationY", "rotationZ",
      "scale", "scaleX", "scaleY", "skewX", "skewY"];
}

function assertSourceCompatible(source: string, document: Document, node: Element, state: PreviewElementState,
  observation: PreviewGsapObservation, gesture: RemoteGsapGesture): void {
  const blocked = blockedChannels(gesture);
  let authoredCount = 0;
  for (const script of document.querySelectorAll("script:not([src])")) {
    for (const animation of parseGsapScriptAcorn(script.textContent ?? "").animations) {
      if (animation.hasUnresolvedSelector || animation.hasUnresolvedKeyframes) {
        throw new Error("Dynamic authored animation cannot be moved from the preview safely");
      }
      let matches: Element[];
      try { matches = [...document.querySelectorAll(animation.targetSelector)]; }
      catch { throw new Error("The authored animation selector is unsupported"); }
      if (!matches.includes(node)) continue;
      authoredCount++;
      if (matches.length !== 1 || animation.method !== "to" && animation.method !== "set" ||
          blocked.some(channel => channel in animation.properties ||
            channel in (animation.fromProperties ?? {}) ||
            animation.keyframes?.keyframes.some(frame => channel in frame.properties))) {
        throw new Error("This authored animation controls the requested geometry");
      }
    }
  }
  if (authoredCount !== observation.tweens.length ||
      countMatchedRemoteGsapTargets(source, state, observation) !== authoredCount) {
    throw new Error("The authored and preview animations no longer agree");
  }
}

/** Move/resize the source box or rotate its base pose without touching GSAP curves. */
export async function commitRemoteGsapGesture(
  state: PreviewElementState,
  observation: PreviewGsapObservation,
  ancestors: readonly PreviewElementState[],
  gesture: RemoteGsapGesture,
  deps: RemoteGsapSourceDeps,
): Promise<boolean> {
  assertSameSelection(state, observation, deps.expectedSourceFile);
  assertFlatAncestry(state, ancestors);
  assertRuntimeCompatible(observation, gesture);
  if (gesture.mode === "move" && (![gesture.delta.x, gesture.delta.y].every(Number.isFinite) ||
      Math.abs(gesture.delta.x) > 100_000 || Math.abs(gesture.delta.y) > 100_000) ||
      gesture.mode === "resize" && (![gesture.width, gesture.height].every(Number.isFinite) ||
        gesture.width <= 0 || gesture.height <= 0 || gesture.width > 100_000 || gesture.height > 100_000) ||
      gesture.mode === "rotate" && (!Number.isFinite(gesture.deltaDegrees) ||
        Math.abs(gesture.deltaDegrees) > 3600)) {
    throw new Error("The legacy gesture geometry is unsupported");
  }
  return serializeStudioFileMutation(deps.writeProjectFile, deps.expectedSourceFile, async () => {
    const before = await deps.readOptionalProjectFile(deps.expectedSourceFile);
    if (before == null) throw new Error("The active composition source is unavailable");
    const { document } = parseHTML(before);
    const node = resolveSourceNode(document as unknown as Document, state) as HTMLElement;
    assertSourceCompatible(before, document as unknown as Document, node, state, observation, gesture);
    if (node.style.position !== "absolute" && node.style.position !== "fixed") {
      throw new Error("This layer needs explicit absolute source positioning");
    }
    if (gesture.mode === "move") {
      const left = pixels(node.style.left);
      const top = pixels(node.style.top);
      if (left === null || top === null) throw new Error("This layer needs explicit pixel left and top values");
      node.style.left = `${clean(left + gesture.delta.x)}px`;
      node.style.top = `${clean(top + gesture.delta.y)}px`;
    } else if (gesture.mode === "resize") {
      const width = pixels(node.style.width);
      const height = pixels(node.style.height);
      if (width === null || height === null || width <= 0 || height <= 0) {
        throw new Error("This layer needs an explicit pixel source box");
      }
      node.style.width = `${clean(gesture.width)}px`;
      node.style.height = `${clean(gesture.height)}px`;
    } else {
      const angle = degrees(node.style.rotate);
      if (angle === null || node.style.transform || node.style.scale || node.style.translate ||
          (state.computedStyles.transform ?? "none") !== "none") {
        throw new Error("This layer has a transform that cannot be rotated safely");
      }
      node.style.rotate = `${clean(angle + gesture.deltaDegrees)}deg`;
    }
    const after = document.toString();
    if (after === before) return false;
    await commitNativeTimelineFileSnapshots({
      orderedPaths: [deps.expectedSourceFile], snapshots: { [deps.expectedSourceFile]: { before, after } },
      history: { kind: "manual", label: `${gesture.mode} legacy layer` },
      commitFileTransaction: deps.commitFileTransaction, writeProjectFile: deps.writeProjectFile,
      recordEdit: deps.recordEdit,
      rollbackFailureMessage: "The legacy gesture failed and rollback did not complete",
    });
    return true;
  });
}
