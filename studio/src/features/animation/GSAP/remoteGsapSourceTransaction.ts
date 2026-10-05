import { parseHTML } from "linkedom";
import { parseGsapScriptAcorn } from "@hyperframes/core/gsap-parser-acorn";
import { addAnimationToScript, addKeyframeToScript, removeAnimationFromScript,
  removeKeyframeFromScript, updateAnimationInScript, updateKeyframeInScript } from "@hyperframes/core/gsap-writer-acorn";
import type { PreviewElementState, PreviewGsapChannel, PreviewGsapKeyframe,
  PreviewGsapObservation } from "../../../../shared/preview/agentProtocol";
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
  start?: number;
  duration?: number;
  keyframes?: PreviewGsapKeyframe[];
}

export interface RemoteGsapSourceDeps {
  /** Trusted editor composition path; authored preview paths are only hints. */
  expectedSourceFile: string;
  readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (entry: RecordEditInput) => Promise<void>;
  commitFileTransaction?: CommitNativeTimelineFileTransaction;
}

export function assertSameSelection(state: PreviewElementState, observation: PreviewGsapObservation,
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

export function resolveSourceNode(document: Document, state: PreviewElementState): Element {
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

type SourceTarget = Omit<RemoteGsapTarget, "start" | "duration"> & {
  script: Element; start: number | null; duration: number | null;
};

function numericKeyframes(animation: { keyframes?: { format: string; keyframes: Array<{
  percentage: number; properties: Record<string, number | string>; ease?: string }> } }):
  PreviewGsapKeyframe[] | null {
  const keyframes = animation.keyframes;
  if (!keyframes || keyframes.format !== "percentage" ||
      keyframes.keyframes.length < 2 || keyframes.keyframes.length > 64) return null;
  const result: PreviewGsapKeyframe[] = [];
  for (const frame of keyframes.keyframes) {
    if (!Number.isFinite(frame.percentage) || frame.percentage < 0 || frame.percentage > 100) return null;
    const properties: PreviewGsapKeyframe["properties"] = {};
    for (const [key, value] of Object.entries(frame.properties)) {
      if (!editableChannels.has(key as PreviewGsapChannel) ||
          typeof value !== "number" || !Number.isFinite(value)) return null;
      properties[key as PreviewGsapChannel] = value;
    }
    if (Object.keys(properties).length === 0) return null;
    result.push({ percentage: frame.percentage, properties,
      ...(frame.ease ? { ease: frame.ease } : {}) });
  }
  if (new Set(result.map(frame => frame.percentage)).size !== result.length) return null;
  return result;
}

function sameKeyframes(source: readonly PreviewGsapKeyframe[], observed: readonly PreviewGsapKeyframe[]): boolean {
  return source.length === observed.length && source.every((frame, index) => {
    const runtime = observed[index];
    const keys = Object.keys(frame.properties);
    return runtime?.percentage === frame.percentage &&
      Object.keys(runtime.properties).length === keys.length &&
      keys.every(key => runtime.properties[key as PreviewGsapChannel] ===
        frame.properties[key as PreviewGsapChannel]) &&
      (runtime.ease ?? "") === (frame.ease ?? "");
  });
}

function targetsFromSource(source: string, state: PreviewElementState,
  observation: PreviewGsapObservation): SourceTarget[] {
  const { document } = parseHTML(source);
  const element = resolveSourceNode(document as unknown as Document, state);
  const candidates: SourceTarget[] = [];
  for (const script of document.querySelectorAll("script:not([src])")) {
    const text = script.textContent ?? "";
    const parsed = parseGsapScriptAcorn(text);
    for (const animation of parsed.animations) {
      if (animation.hasUnresolvedSelector || animation.hasUnresolvedKeyframes ||
          (animation.method !== "to" && animation.method !== "set") ||
          !onlySourceTarget(document as unknown as Document, animation.targetSelector, element)) continue;
      const keyframes = animation.keyframes ? numericKeyframes(animation) : undefined;
      if (animation.keyframes && !keyframes) continue;
      const properties: RemoteGsapTarget["properties"] = {};
      for (const [key, value] of Object.entries(animation.properties)) {
        if (editableChannels.has(key as PreviewGsapChannel) && observedChannels.has(key as PreviewGsapChannel)
            && typeof value === "number" && Number.isFinite(value)) {
          properties[key as PreviewGsapChannel] = value;
        }
      }
      if (keyframes) Object.assign(properties, keyframes.at(-1)?.properties);
      if (Object.keys(properties).length === 0) continue;
      candidates.push({ id: animation.id, label: `${animation.method} ${animation.targetSelector}`,
        properties, script, ...(keyframes ? { keyframes } : {}),
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
    (candidate.keyframes
      ? Boolean(tween.keyframes && sameKeyframes(candidate.keyframes, tween.keyframes))
      : !tween.keyframes && Object.entries(candidate.properties)
        .every(([key, value]) => tween.properties[key as PreviewGsapChannel] === value));
  return candidates.filter(candidate => {
    const exactId = completeTweens.filter(tween => tween.animationId === candidate.id && shapeMatches(candidate, tween));
    if (exactId.length === 1) return true;
    if (exactId.length > 1) return false;
    const matchingTweens = completeTweens.filter(tween => !tween.animationId && shapeMatches(candidate, tween));
    return matchingTweens.length === 1 &&
      candidates.filter(other => shapeMatches(other, matchingTweens[0]!)).length === 1;
  });
}

/** Every tween affecting a source geometry gesture must match authored source exactly. */
export function countMatchedRemoteGsapTargets(source: string, state: PreviewElementState,
  observation: PreviewGsapObservation): number {
  return targetsFromSource(source, state, observation).length;
}

type KeyframeEdit = {
  animationId: string;
  action: "update" | "add" | "remove";
  percentage: number;
  property?: PreviewGsapChannel;
  value?: number;
};

/** Keyframe edits are limited to literal percentage keys with matching live evidence. */
export async function commitRemoteGsapKeyframeEdit(
  state: PreviewElementState,
  observation: PreviewGsapObservation,
  edit: KeyframeEdit,
  deps: RemoteGsapSourceDeps,
): Promise<boolean> {
  assertSameSelection(state, observation, deps.expectedSourceFile);
  if (!Number.isFinite(edit.percentage) || edit.percentage < 0 || edit.percentage > 100 ||
      (edit.action !== "remove" && (!edit.property || !editableChannels.has(edit.property) ||
        typeof edit.value !== "number" || !Number.isFinite(edit.value) || Math.abs(edit.value) > 1_000_000 ||
        (edit.property === "opacity" && (edit.value < 0 || edit.value > 1))))) {
    throw new Error("The legacy keyframe value is unsupported");
  }
  return serializeStudioFileMutation(deps.writeProjectFile, deps.expectedSourceFile, async () => {
    const before = await deps.readOptionalProjectFile(deps.expectedSourceFile);
    if (before == null) throw new Error("The active composition source is unavailable");
    const targets = targetsFromSource(before, state, observation);
    const target = targets.find(candidate => candidate.id === edit.animationId && candidate.keyframes);
    if (!target?.keyframes) throw new Error("The selected authored keyframes are no longer uniquely editable");
    const exists = target.keyframes.find(frame => frame.percentage === edit.percentage);
    if (edit.action === "add" && exists || edit.action !== "add" && !exists ||
        edit.action === "remove" && target.keyframes.length <= 2 ||
        edit.action !== "remove" && (!edit.property ||
          !target.keyframes.every(frame => Object.hasOwn(frame.properties, edit.property!)))) {
      throw new Error("The keyframe edit would alter an unsupported authored curve");
    }
    const original = target.script.textContent ?? "";
    let changed: string;
    if (edit.action === "remove") {
      changed = removeKeyframeFromScript(original, edit.animationId, edit.percentage);
    } else if (edit.action === "add") {
      changed = addKeyframeToScript(original, edit.animationId, edit.percentage,
        { [edit.property!]: edit.value! });
    } else {
      changed = updateKeyframeInScript(original, edit.animationId, edit.percentage,
        { [edit.property!]: edit.value! });
    }
    if (changed === original) return false;
    target.script.textContent = changed;
    const parsed = parseGsapScriptAcorn(changed).animations.find(item => item.id === edit.animationId);
    const updated = parsed?.keyframes?.keyframes.find(frame => frame.percentage === edit.percentage);
    if (!parsed || (edit.action === "remove" ? Boolean(updated) :
        !updated || updated.properties[edit.property!] !== edit.value)) {
      throw new Error("The authored keyframe update could not be verified");
    }
    const after = target.script.ownerDocument.toString();
    await commitNativeTimelineFileSnapshots({
      orderedPaths: [deps.expectedSourceFile], snapshots: { [deps.expectedSourceFile]: { before, after } },
      history: { kind: "manual", label: `${edit.action} GSAP keyframe` },
      commitFileTransaction: deps.commitFileTransaction, writeProjectFile: deps.writeProjectFile,
      recordEdit: deps.recordEdit,
      rollbackFailureMessage: "The legacy keyframe edit failed and rollback did not complete",
    });
    return true;
  });
}

type AnimationAction =
  | { action: "remove"; animationId: string }
  | { action: "add"; method: "to" | "set"; property: PreviewGsapChannel;
      value: number; position?: number; duration?: number };

/** Add a first literal tween or remove one exactly matched authored tween. */
export async function commitRemoteGsapAnimationAction(
  state: PreviewElementState,
  observation: PreviewGsapObservation,
  action: AnimationAction,
  deps: RemoteGsapSourceDeps,
): Promise<boolean> {
  assertSameSelection(state, observation, deps.expectedSourceFile);
  if (action.action === "add" &&
      (!editableChannels.has(action.property) || !Number.isFinite(action.value) ||
       Math.abs(action.value) > 1_000_000 ||
       action.property === "opacity" && (action.value < 0 || action.value > 1) ||
       !Number.isFinite(action.position ?? 0) || (action.position ?? 0) < 0 ||
       (action.method === "to" && (!Number.isFinite(action.duration) ||
         (action.duration ?? 0) <= 0 || (action.duration ?? 0) > 86400)))) {
    throw new Error("The new authored animation is unsupported");
  }
  return serializeStudioFileMutation(deps.writeProjectFile, deps.expectedSourceFile, async () => {
    const before = await deps.readOptionalProjectFile(deps.expectedSourceFile);
    if (before == null) throw new Error("The active composition source is unavailable");
    const { document } = parseHTML(before);
    const element = resolveSourceNode(document as unknown as Document, state);
    const candidates = targetsFromSource(before, state, observation);
    let script: Element;
    let changed: string;
    let newId: string | null = null;
    if (action.action === "remove") {
      const target = candidates.find(item => item.id === action.animationId);
      if (!target) throw new Error("The authored animation is no longer uniquely editable");
      script = [...document.querySelectorAll("script:not([src])")].find(item =>
        parseGsapScriptAcorn(item.textContent ?? "").animations.some(anim => anim.id === target.id))!;
      if (!script) throw new Error("The authored animation source is ambiguous");
      changed = removeAnimationFromScript(script.textContent ?? "", target.id);
      if (changed === script.textContent) return false;
      if (parseGsapScriptAcorn(changed).animations.some(anim => anim.id === target.id)) {
        throw new Error("The authored animation removal could not be verified");
      }
    } else {
      if (!state.id || !state.selector?.startsWith("#") ||
          !onlySourceTarget(document as unknown as Document, state.selector, element) ||
          observation.tweens.length !== 0) {
        throw new Error("A new animation needs one idle source-bound element");
      }
      for (const sourceScript of document.querySelectorAll("script:not([src])")) {
        for (const animation of parseGsapScriptAcorn(sourceScript.textContent ?? "").animations) {
          if (animation.hasUnresolvedSelector) {
            throw new Error("Dynamic authored targets prevent safe animation insertion");
          }
          let existingTargets: Element[];
          try { existingTargets = [...document.querySelectorAll(animation.targetSelector)]; }
          catch { throw new Error("The authored animation selector is unsupported"); }
          if (existingTargets.includes(element)) {
            throw new Error("An authored animation already targets this element");
          }
        }
      }
      const scripts = [...document.querySelectorAll("script:not([src])")].filter(item => {
        const text = item.textContent ?? "";
        return text.includes("gsap.timeline(") && text.includes("window.__timelines");
      });
      if (scripts.length !== 1) throw new Error("The authored GSAP timeline is ambiguous");
      script = scripts[0]!;
      const inserted = addAnimationToScript(script.textContent ?? "", {
        targetSelector: state.selector, method: action.method,
        position: action.position ?? 0, ...(action.method === "to" ? { duration: action.duration } : {}),
        properties: { [action.property]: action.value },
      });
      changed = inserted.script;
      newId = inserted.id;
      if (!newId || changed === script.textContent ||
          !parseGsapScriptAcorn(changed).animations.some(anim => anim.id === newId &&
            anim.targetSelector === state.selector && anim.properties[action.property] === action.value)) {
        throw new Error("The new authored animation could not be verified");
      }
    }
    script.textContent = changed;
    const after = document.toString();
    await commitNativeTimelineFileSnapshots({
      orderedPaths: [deps.expectedSourceFile], snapshots: { [deps.expectedSourceFile]: { before, after } },
      history: { kind: "manual", label: action.action === "add" ? "Add GSAP animation" : "Remove GSAP animation" },
      commitFileTransaction: deps.commitFileTransaction, writeProjectFile: deps.writeProjectFile,
      recordEdit: deps.recordEdit,
      rollbackFailureMessage: "The legacy animation edit failed and rollback did not complete",
    });
    return true;
  });
}

export async function loadRemoteGsapTargets(state: PreviewElementState,
  observation: PreviewGsapObservation, deps: Pick<RemoteGsapSourceDeps, "expectedSourceFile" | "readOptionalProjectFile">):
  Promise<RemoteGsapTarget[]> {
  assertSameSelection(state, observation, deps.expectedSourceFile);
  const source = await deps.readOptionalProjectFile(deps.expectedSourceFile);
  if (source == null) throw new Error("The active composition source is unavailable");
  return targetsFromSource(source, state, observation).map(({ script: _script, start, duration, ...target }) => ({
    ...target,
    ...(start === null ? {} : { start }),
    ...(duration === null ? {} : { duration }),
  }));
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
