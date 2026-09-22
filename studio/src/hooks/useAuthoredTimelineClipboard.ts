import { useCallback, useEffect, useRef } from "react";
import { usePlayerStore, type TimelineElement } from "../player";
import {
  captureAuthoredClips,
  pasteAuthoredClips,
  type AuthoredClipSnapshot,
} from "../utils/authoredClipClipboard";
import {
  captureNativeClips,
  pasteNativeClips,
  type NativeClipClipboardSnapshot,
} from "../project/nativeClipClipboard";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
} from "../project/nativeProjectDocument";
import { projectFrameFromSeconds } from "../project/nativePropertyEditPlan";
import { commitNativeTimelineFileSnapshots } from "../project/nativeTimelineTransactionCommit";
import { serializeStudioFileMutations } from "../utils/studioFileMutationCoordinator";
import type { NativeTimelineEditingDependencies } from "./useTimelineEditingTypes";
import type { RecordEditInput } from "../utils/studioFileHistory";
import { readFileContent } from "./timelineEditingHelpers";

interface Options {
  clearCanvasSelection?: () => void;
  projectId: string | null;
  activeCompPath: string | null;
  showToast: (message: string, tone?: "error" | "info") => void;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (entry: RecordEditInput) => Promise<void>;
  domEditSaveTimestampRef: React.MutableRefObject<number>;
  reloadPreview: () => void;
  nativeProjectEditing?: NativeTimelineEditingDependencies;
  handleTimelineElementsDelete?: (elements: TimelineElement[]) => Promise<void>;
}
interface Snapshot {
  projectId: string;
  sourceFile: string;
  authored: AuthoredClipSnapshot;
  native: NativeClipClipboardSnapshot | null;
  elements: TimelineElement[];
  endSeconds: number;
}
const selectedClips = () => {
  const state = usePlayerStore.getState();
  const ids = state.selectedElementIds.size
    ? state.selectedElementIds
    : new Set([state.selectedElementId]);
  return state.elements.filter((element) => ids.has(element.key ?? element.id));
};

export function useAuthoredTimelineClipboard(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const clipboard = useRef<Promise<Snapshot | null> | null>(null);
  const pendingSelection = useRef<{
    projectId: string;
    sourceFile: string;
    domIds: string[];
  } | null>(null);
  useEffect(() => {
    const unsubscribe = usePlayerStore.subscribe((state) => {
      const pending = pendingSelection.current;
      if (!pending) return;
      if (
        pending.projectId !== latest.current.projectId ||
        pending.sourceFile !== (latest.current.activeCompPath || "index.html")
      ) {
        pendingSelection.current = null;
        return;
      }
      const copied = state.elements.filter(
        (el) =>
          pending.domIds.includes(el.domId ?? el.id) &&
          (el.sourceFile || "index.html") === pending.sourceFile,
      );
      if (copied.length !== pending.domIds.length) return;
      pendingSelection.current = null;
      latest.current.clearCanvasSelection?.();
      const ids = new Set(copied.map((el) => el.key ?? el.id));
      usePlayerStore.setState({
        selectedElementIds: ids,
        selectedElementId: ids.values().next().value!,
        timelineSelectionOwnsCommands: true,
        selectedKeyframes: new Set(),
      });
    });
    return () => {
      pendingSelection.current = null;
      unsubscribe();
    };
  }, []);
  const capture = useCallback(
    async (elements: TimelineElement[], dependencies: Options): Promise<Snapshot> => {
      const projectId = dependencies.projectId;
      if (!projectId || !elements.length) throw new Error("Select clips to copy.");
      if (elements.some((element) => element.expandedHostKey || element.parentCompositionId))
        throw new Error(
          "Copy the nested composition as a whole, or open it before copying its contents.",
        );
      const sourceFile = elements[0]!.sourceFile || dependencies.activeCompPath || "index.html";
      if (
        elements.some(
          (element) =>
            (element.sourceFile || dependencies.activeCompPath || "index.html") !== sourceFile,
        )
      ) {
        throw new Error("Copy clips from one open composition at a time.");
      }
      return serializeStudioFileMutations(
        dependencies.writeProjectFile,
        [sourceFile, NATIVE_PROJECT_DOCUMENT_PATH],
        async () => {
          const source = await readFileContent(projectId, sourceFile);
          const rawNative = await dependencies.nativeProjectEditing?.readOptionalProjectFile(
            NATIVE_PROJECT_DOCUMENT_PATH,
          );
          const document = rawNative?.trim()
            ? parseNativeProjectDocument(JSON.parse(rawNative))
            : null;
          const authored = captureAuthoredClips(
            source,
            elements.map((element) => ({
              id: element.domId ?? element.id,
              hfId: element.hfId,
              selector: element.selector,
              selectorIndex: element.selectorIndex,
            })),
          );
          const native = document
            ? captureNativeClips(
                document,
                elements.map((element) => ({ ...element, sourceFile })),
              )
            : null;
          return {
            projectId,
            sourceFile,
            authored,
            native,
            elements,
            endSeconds: Math.max(...elements.map((element) => element.start + element.duration)),
          };
        },
      );
    },
    [],
  );
  const report = useCallback(
    (error: unknown) =>
      latest.current.showToast(
        error instanceof Error ? error.message : "Clipboard operation failed.",
        "error",
      ),
    [],
  );

  const copy = useCallback((): boolean => {
    const elements = selectedClips();
    if (!elements.length) return false;
    clipboard.current = capture(elements, latest.current)
      .then((snapshot) => {
        latest.current.showToast(
          `Copied ${elements.length === 1 ? "clip" : `${elements.length} clips`}`,
          "info",
        );
        return snapshot;
      })
      .catch((error) => {
        report(error);
        return null;
      });
    return true;
  }, [capture, report]);

  const pasteSnapshot = useCallback(
    async (snapshot: Snapshot, atSeconds: number, dependencies: Options, label: string) => {
      if (
        snapshot.projectId !== dependencies.projectId ||
        snapshot.sourceFile !== (dependencies.activeCompPath || "index.html")
      ) {
        throw new Error(
          "Paste these clips into their original project and composition; cross-project media transfer is not available yet.",
        );
      }
      const paths = [snapshot.sourceFile, NATIVE_PROJECT_DOCUMENT_PATH];
      await serializeStudioFileMutations(dependencies.writeProjectFile, paths, async () => {
        if (latest.current.projectId !== snapshot.projectId)
          throw new Error("The active project changed before paste.");
        const before = await readFileContent(snapshot.projectId, snapshot.sourceFile);
        const nativeBefore = await dependencies.nativeProjectEditing?.readOptionalProjectFile(
          NATIVE_PROJECT_DOCUMENT_PATH,
        );
        const current = nativeBefore?.trim()
          ? parseNativeProjectDocument(JSON.parse(nativeBefore))
          : null;
        if (snapshot.native?.clips.some(Boolean) && !current)
          throw new Error("The native project is unavailable; paste was cancelled.");
        const secondsPerFrame = current
          ? current.frameRate.denominator / current.frameRate.numerator
          : null;
        const time = current
          ? projectFrameFromSeconds(atSeconds, current.frameRate) * secondsPerFrame!
          : atSeconds;
        const nonce = crypto.randomUUID();
        const pasted = pasteAuthoredClips(before, snapshot.authored, time, nonce);
        const snapshots: Record<string, { before: string; after: string }> = {
          [snapshot.sourceFile]: { before, after: pasted.content },
        };
        let next = current;
        if (current && snapshot.native?.clips.some(Boolean)) {
          next = pasteNativeClips(
            current,
            snapshot.native,
            pasted.bindings,
            snapshot.sourceFile,
            projectFrameFromSeconds(time, current.frameRate) -
              projectFrameFromSeconds(Math.min(...snapshot.authored.starts), current.frameRate),
            nonce,
          );
          next.revision = current.revision + 1;
          snapshots[NATIVE_PROJECT_DOCUMENT_PATH] = {
            before: nativeBefore!,
            after: serializeNativeProjectDocument(next),
          };
        }
        dependencies.domEditSaveTimestampRef.current = Date.now();
        await commitNativeTimelineFileSnapshots({
          orderedPaths: Object.keys(snapshots),
          snapshots,
          history: { label, kind: "timeline" },
          commitFileTransaction: dependencies.nativeProjectEditing?.commitFileTransaction,
          writeProjectFile: dependencies.writeProjectFile,
          recordEdit: dependencies.recordEdit,
          rollbackFailureMessage: "Clip paste failed and rollback was incomplete",
        });
        if (next && next !== current)
          dependencies.nativeProjectEditing?.onNativeDocumentCommitted(next);
        pendingSelection.current = {
          projectId: snapshot.projectId,
          sourceFile: snapshot.sourceFile,
          domIds: pasted.bindings.map((binding) => binding.domId),
        };
      });
      if (latest.current.projectId === snapshot.projectId) dependencies.reloadPreview();
      dependencies.showToast(
        label === "Duplicate clips" ? "Duplicated clips" : "Pasted clips",
        "info",
      );
    },
    [],
  );

  const paste = useCallback(
    async (invokedTime?: number): Promise<boolean> => {
      const pending = clipboard.current;
      if (!pending) return false;
      const at = invokedTime ?? usePlayerStore.getState().currentTime;
      const dependencies = latest.current;
      try {
        const snapshot = await pending;
        if (snapshot) await pasteSnapshot(snapshot, at, dependencies, "Paste clips");
      } catch (error) {
        report(error);
      }
      return true;
    },
    [pasteSnapshot, report],
  );

  const cut = useCallback(async (): Promise<boolean> => {
    const elements = selectedClips();
    if (!elements.length) return false;
    const dependencies = latest.current;
    try {
      if (elements.some((element) => element.timelineLocked))
        throw new Error("Unlock selected clips before cutting them.");
      if (!dependencies.handleTimelineElementsDelete) throw new Error("Clip cut is unavailable.");
      const pending = capture(elements, dependencies);
      clipboard.current = pending.catch(() => null);
      await pending;
      if (latest.current.projectId !== dependencies.projectId)
        throw new Error("The active project changed before cut.");
      await dependencies.handleTimelineElementsDelete(elements);
    } catch (error) {
      report(error);
    }
    return true;
  }, [capture, report]);

  const duplicate = useCallback(async () => {
    const dependencies = latest.current;
    try {
      const snapshot = await capture(selectedClips(), dependencies);
      await pasteSnapshot(snapshot, snapshot.endSeconds, dependencies, "Duplicate clips");
    } catch (error) {
      report(error);
    }
  }, [capture, pasteSnapshot, report]);
  return { copy, paste, cut, duplicate };
}
