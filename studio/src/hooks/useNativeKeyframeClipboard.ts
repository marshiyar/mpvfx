import { useCallback, useRef } from "react";
import { usePlayerStore } from "../player";
import type { NativeTimelineEditingDependencies } from "./useTimelineEditingTypes";
import type { RecordEditInput } from "../utils/studioFileHistory";
import {
  captureNativeKeyframes,
  pasteNativeKeyframes,
  type NativeKeyframeClipboard,
} from "../project/nativeKeyframeClipboard";
import { applyNativeProjectKeyframeCommand } from "../project/nativeProjectKeyframeCommands";
import { createNativeProjectRepository } from "../project/nativeProjectPersistence";
import {
  projectFrameFromSeconds,
  resolveNativeClipSelection,
} from "../project/nativePropertyEditPlan";
import {
  timelineKeyframeSelectionKey,
  timelineKeyframeTargetFromSelectionKey,
} from "../player/components/timelineKeyframeIdentity";
import type { NativeSelectedKeyframeAddress } from "../player/components/deleteSelectedKeyframes";
import { nativeTimelinePropertyLanesForElement } from "../player/components/nativeTimelinePropertyLaneBridge";
import { mergeTimelinePropertyLanes } from "../player/components/TimelinePropertyLanes";

interface Options {
  projectId: string | null;
  nativeProjectEditing?: NativeTimelineEditingDependencies;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (entry: RecordEditInput) => Promise<void>;
  showToast: (message: string, tone?: "error" | "info") => void;
}
function selection(): NativeSelectedKeyframeAddress[] {
  const state = usePlayerStore.getState();
  const result: NativeSelectedKeyframeAddress[] = [];
  const seen = new Set<string>();
  for (const key of state.selectedKeyframes) {
    const target = state.elements
      .map((element) => timelineKeyframeTargetFromSelectionKey(element.key ?? element.id, key))
      .find(Boolean);
    const targets = target?.nativeTargets ?? (target?.native ? [target.native] : []);
    if (!targets.length)
      throw new Error(
        "These legacy keyframes cannot be pasted independently yet. Copy their complete clip to retain the animation.",
      );
    for (const t of targets) {
      const address = {
        sequenceId: t.sequenceId,
        trackId: t.trackId,
        clipId: t.clipId,
        parameterId: t.parameterId,
      };
      const id = JSON.stringify([address, t.frame]);
      if (!seen.has(id)) {
        seen.add(id);
        result.push({ address, frame: t.frame });
      }
    }
  }
  return result;
}
export function useNativeKeyframeClipboard(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const clipboard = useRef<NativeKeyframeClipboard | null>(null);
  const owns = useRef(false);
  const report = (error: unknown) =>
    latest.current.showToast(
      error instanceof Error ? error.message : "Keyframe clipboard failed.",
      "error",
    );
  const copy = useCallback(() => {
    if (!usePlayerStore.getState().selectedKeyframes.size) return false;
    owns.current = true;
    clipboard.current = null;
    try {
      const doc = latest.current.nativeProjectEditing?.nativeDocument;
      if (!doc) throw new Error("Save the native animation before copying its keyframes.");
      clipboard.current = captureNativeKeyframes(doc, selection());
      latest.current.showToast("Copied keyframes", "info");
    } catch (error) {
      report(error);
    }
    return true;
  }, []);
  const repository = (dependencies: Options) => {
    const native = dependencies.nativeProjectEditing;
    if (!native?.nativeDocument) throw new Error("The native animation is unavailable.");
    return createNativeProjectRepository({
      ...native,
      writeProjectFile: dependencies.writeProjectFile,
      recordHistory: (entry) =>
        dependencies.recordEdit({
          label: entry.label,
          kind: "motion",
          files: {
            [entry.path]: { before: entry.before ?? "", after: entry.after },
          },
        }),
    });
  };
  const paste = useCallback(async () => {
    if (!owns.current) return false;
    const copied = clipboard.current;
    if (!copied) return true;
    const dependencies = latest.current;
    const state = usePlayerStore.getState();
    const document = dependencies.nativeProjectEditing?.nativeDocument;
    const element = state.elements.find((el) => (el.key ?? el.id) === state.selectedElementId);
    const playhead = state.currentTime;
    try {
      if (!document || !element)
        throw new Error("Select a destination clip before pasting keyframes.");
      if (element.timelineLocked)
        throw new Error("Unlock the destination clip before pasting keyframes.");
      const resolved = resolveNativeClipSelection(document, element);
      if (!resolved.ok) throw new Error("The destination must support native keyframe editing.");
      const destination = {
        sequenceId: document.sequence.id,
        trackId: resolved.located.trackId,
        clipId: resolved.located.clip.id,
      };
      const frame = projectFrameFromSeconds(playhead, document.frameRate);
      const repo = repository(dependencies);
      const current = await repo.load();
      if (!current || latest.current.projectId !== dependencies.projectId)
        throw new Error("The project changed before paste.");
      let selected: NativeSelectedKeyframeAddress[] = [];
      const committed = await repo.transaction(
        {
          expectedRevision: current.document.revision,
          label: "Paste keyframes",
        },
        (draft) => {
          const result = pasteNativeKeyframes(
            draft,
            copied,
            destination,
            frame,
            crypto.randomUUID(),
          );
          selected = result.selection;
          return result.document;
        },
      );
      dependencies.nativeProjectEditing?.onNativeDocumentCommitted(committed.document);

      const projection = nativeTimelinePropertyLanesForElement(committed.document, element);
      const lanes = mergeTimelinePropertyLanes(
        [],
        projection?.lanes ?? [],
        element.start,
        element.duration,
      );
      const keys = lanes
        .flatMap((lane) => lane.keyframes)
        .filter((key) =>
          (key.nativeTargets ?? (key.native ? [key.native] : [])).some((target) =>
            selected.some(
              (k) => k.address.parameterId === target.parameterId && k.frame === target.frame,
            ),
          ),
        )
        .map((key) => timelineKeyframeSelectionKey(element.key ?? element.id, key));
      if (usePlayerStore.getState().selectedElementId === (element.key ?? element.id))
        usePlayerStore.setState({ selectedKeyframes: new Set(keys) });
      dependencies.showToast("Pasted keyframes", "info");
    } catch (error) {
      report(error);
    }
    return true;
  }, []);
  const cut = useCallback(async () => {
    if (!usePlayerStore.getState().selectedKeyframes.size) return false;
    const dependencies = latest.current;
    if (!copy() || !clipboard.current) return true;
    try {
      const state = usePlayerStore.getState();
      if (
        state.elements.some(
          (element) =>
            element.timelineLocked &&
            [...state.selectedKeyframes].some((key) =>
              timelineKeyframeTargetFromSelectionKey(element.key ?? element.id, key),
            ),
        )
      ) {
        throw new Error("Unlock selected clips before cutting their keyframes.");
      }
      const targets = selection();
      const repo = repository(dependencies);
      const current = await repo.load();
      if (!current || latest.current.projectId !== dependencies.projectId)
        throw new Error("The project changed before cut.");
      const committed = await repo.transaction(
        { expectedRevision: current.document.revision, label: "Cut keyframes" },
        (draft) => {
          const result = applyNativeProjectKeyframeCommand(draft, {
            type: "batch",
            commands: targets.map((t) => ({
              type: "delete",
              address: t.address,
              frame: t.frame,
            })),
          });
          if (!result.ok) throw new Error(result.failure.message);
          return result.document;
        },
      );
      dependencies.nativeProjectEditing?.onNativeDocumentCommitted(committed.document);
      usePlayerStore.getState().clearSelectedKeyframes();
    } catch (error) {
      report(error);
    }
    return true;
  }, [copy]);
  const clear = useCallback(() => {
    owns.current = false;
  }, []);
  return { copy, paste, cut, clear };
}
