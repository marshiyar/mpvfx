import { parseHTML } from "linkedom";
import { parseGsapScriptAcorn } from "@hyperframes/core/gsap-parser-acorn";
import { updateAnimationInScript } from "@hyperframes/core/gsap-writer-acorn";
import type { PreviewElementState, PreviewGsapChannel, PreviewGsapObservation } from "../../../../shared/preview/agentProtocol";
import { PREVIEW_GSAP_CHANNELS } from "../../../../shared/preview/agentProtocol";
import { serializeStudioFileMutation } from "../../history/studioFileMutationCoordinator";
import { commitNativeTimelineFileSnapshots, type CommitNativeTimelineFileTransaction } from "../../project/nativeTimelineTransactionCommit";
import type { RecordEditInput } from "../../history/studioFileHistory";

const editableChannels = new Set<PreviewGsapChannel>(["x", "y", "rotation", "scale", "scaleX", "scaleY", "opacity"]);
const observedChannels = new Set<PreviewGsapChannel>(PREVIEW_GSAP_CHANNELS);

export interface RemoteGsapTarget {
  id: string;
  label: string;
  properties: Partial<Record<PreviewGsapChannel, number>>;
}

export interface RemoteGsapSourceDeps {
  /** Trusted editor composition path; authored preview paths are only hints. */
  expectedSourceFile: string;
  readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (entry: RecordEditInput) => Promise<void>;
  commitFileTransaction?: CommitNativeTimelineFileTransaction;
}

function assertSameSelection(state: PreviewElementState, observation: PreviewGsapObservation,
  expectedSourceFile: string): void {
  if (!expectedSourceFile || state.sourceFile !== expectedSourceFile ||
      state.compositionPath !== expectedSourceFile ||
      observation.sourceFile !== expectedSourceFile || observation.compositionPath !== expectedSourceFile ||
      observation.handle !== state.handle || observation.id !== state.id ||
      observation.hfId !== (state.dataAttributes["hf-id"] ?? "")) {
    throw new Error("The selected preview element no longer matches the active composition");
  }
  if (!state.id && !observation.hfId) throw new Error("Legacy animation editing needs a stable element ID");
}

function resolveSourceNode(document: Document, state: PreviewElementState): Element {
  const elements = [...document.querySelectorAll("*")];
  const id = state.id;
  const hfId = state.dataAttributes["hf-id"] ?? "";
  const candidates = elements.filter(element =>
    (!id || element.id === id) && (!hfId || element.getAttribute("data-hf-id") === hfId));
  if (candidates.length !== 1 ||
      (id && elements.filter(element => element.id === id).length !== 1) ||
      (hfId && elements.filter(element => element.getAttribute("data-hf-id") === hfId).length !== 1)) {
    throw new Error("The selected source element cannot be resolved uniquely");
  }
  return candidates[0]!;
}

function onlySourceTarget(document: Document, selector: string, element: Element): boolean {
  if (!selector || selector.length > 512) return false;
  try {
    const matches = [...document.querySelectorAll(selector)];
    return matches.length === 1 && matches[0] === element;
  } catch { return false; }
}

type SourceTarget = RemoteGsapTarget & { script: Element; start: number | null; duration: number | null };

function targetsFromSource(source: string, state: PreviewElementState,
  observation: PreviewGsapObservation): SourceTarget[] {
  const { document } = parseHTML(source);
  const element = resolveSourceNode(document as unknown as Document, state);
  const candidates: SourceTarget[] = [];
  for (const script of document.querySelectorAll("script:not([src])")) {
    const text = script.textContent ?? "";
    if (!text.includes("gsap.") && !text.includes("tl.")) continue;
    const parsed = parseGsapScriptAcorn(text);
    for (const animation of parsed.animations) {
      if (animation.hasUnresolvedSelector || animation.hasUnresolvedKeyframes || animation.keyframes ||
          (animation.method !== "to" && animation.method !== "set") ||
          !onlySourceTarget(document as unknown as Document, animation.targetSelector, element)) continue;
      const properties: RemoteGsapTarget["properties"] = {};
      for (const [key, value] of Object.entries(animation.properties)) {
        if (editableChannels.has(key as PreviewGsapChannel) && observedChannels.has(key as PreviewGsapChannel)
            && typeof value === "number" && Number.isFinite(value)) {
          properties[key as PreviewGsapChannel] = value;
        }
      }
      if (Object.keys(properties).length === 0) continue;
      candidates.push({ id: animation.id, label: `${animation.method} ${animation.targetSelector}`,
        properties, script,
        start: typeof animation.resolvedStart === "number" ? animation.resolvedStart :
          typeof animation.position === "number" ? animation.position : null,
        duration: typeof animation.duration === "number" ? animation.duration :
          animation.method === "set" ? 0 : null });
    }
  }
  const ids = new Set(candidates.map(candidate => candidate.id));
  if (ids.size !== candidates.length) throw new Error("The authored animation ID is ambiguous");
  const completeTweens = observation.tweens.filter(tween => tween.complete);
  const sameNumber = (left: number | null, right: number): boolean =>
    left !== null && Math.abs(left - right) < 1e-6;
  const shapeMatches = (candidate: SourceTarget, tween: PreviewGsapObservation["tweens"][number]): boolean =>
    sameNumber(candidate.start, tween.start) && sameNumber(candidate.duration, tween.duration) &&
    Object.entries(candidate.properties).every(([key, value]) => tween.properties[key as PreviewGsapChannel] === value);
  return candidates.filter(candidate => {
    const exactId = completeTweens.filter(tween => tween.animationId === candidate.id);
    if (exactId.length === 1) return true;
    if (exactId.length > 1) return false;
    const matchingTweens = completeTweens.filter(tween => !tween.animationId && shapeMatches(candidate, tween));
    return matchingTweens.length === 1 &&
      candidates.filter(other => shapeMatches(other, matchingTweens[0]!)).length === 1;
  });
}

export async function loadRemoteGsapTargets(state: PreviewElementState,
  observation: PreviewGsapObservation, deps: Pick<RemoteGsapSourceDeps, "expectedSourceFile" | "readOptionalProjectFile">):
  Promise<RemoteGsapTarget[]> {
  assertSameSelection(state, observation, deps.expectedSourceFile);
  const source = await deps.readOptionalProjectFile(deps.expectedSourceFile);
  if (source == null) throw new Error("The active composition source is unavailable");
  return targetsFromSource(source, state, observation).map(({ script: _script, start: _start,
    duration: _duration, ...target }) => target);
}

/** One exact source animation, one CAS file write, one durable Undo snapshot. */
export async function commitRemoteGsapPropertyEdit(
  state: PreviewElementState,
  observation: PreviewGsapObservation,
  edit: { animationId: string; property: PreviewGsapChannel; value: number },
  deps: RemoteGsapSourceDeps,
): Promise<boolean> {
  assertSameSelection(state, observation, deps.expectedSourceFile);
  if (!editableChannels.has(edit.property) || !Number.isFinite(edit.value) || Math.abs(edit.value) > 1_000_000 ||
      (edit.property === "opacity" && (edit.value < 0 || edit.value > 1))) {
    throw new Error("The legacy animation value is unsupported");
  }
  return serializeStudioFileMutation(deps.writeProjectFile, deps.expectedSourceFile, async () => {
    const before = await deps.readOptionalProjectFile(deps.expectedSourceFile);
    if (before == null) throw new Error("The active composition source is unavailable");
    const targets = targetsFromSource(before, state, observation);
    const target = targets.find(candidate => candidate.id === edit.animationId);
    if (!target || !Object.hasOwn(target.properties, edit.property)) {
      throw new Error("The selected authored animation is no longer uniquely editable");
    }
    if (target.properties[edit.property] === edit.value) return false;
    const { document } = parseHTML(before);
    const sourceNode = resolveSourceNode(document as unknown as Document, state);
    const scripts = [...document.querySelectorAll("script:not([src])")];
    const matches = scripts.filter(script => {
      try {
        const parsed = parseGsapScriptAcorn(script.textContent ?? "");
        return parsed.animations.some(animation => animation.id === edit.animationId &&
          onlySourceTarget(document as unknown as Document, animation.targetSelector, sourceNode));
      } catch { return false; }
    });
    if (matches.length !== 1) throw new Error("The authored animation script is ambiguous");
    const script = matches[0]!;
    const originalScript = script.textContent ?? "";
    const parsed = parseGsapScriptAcorn(originalScript);
    const animation = parsed.animations.find(item => item.id === edit.animationId);
    if (!animation || typeof animation.properties[edit.property] !== "number") {
      throw new Error("The authored animation changed before saving");
    }
    script.textContent = updateAnimationInScript(originalScript, edit.animationId, {
      properties: { ...animation.properties, [edit.property]: edit.value },
    });
    const after = document.toString();
    const verified = parseGsapScriptAcorn(script.textContent).animations.find(item => item.id === edit.animationId);
    if (!verified || verified.properties[edit.property] !== edit.value ||
        !resolveSourceNode(document as unknown as Document, state) || after === before) {
      throw new Error("The authored animation update could not be verified");
    }
    await commitNativeTimelineFileSnapshots({
      orderedPaths: [deps.expectedSourceFile],
      snapshots: { [deps.expectedSourceFile]: { before, after } },
      history: { kind: "manual", label: `Edit GSAP ${edit.property}` },
      commitFileTransaction: deps.commitFileTransaction,
      writeProjectFile: deps.writeProjectFile,
      recordEdit: deps.recordEdit,
      rollbackFailureMessage: "The legacy animation edit failed and rollback did not complete",
    });
    return true;
  });
}
