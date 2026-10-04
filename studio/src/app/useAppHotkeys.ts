import { useCallback, useEffect, useRef } from "react";
import { automationOwnsKey } from "../features/animation/useAutomationSelectionKeyboard";
import { usePlayerStore } from "../player/index";
import type { TimelineElement } from "../player/index";
import type { DomEditSelection } from "../features/canvas/domEditing";
import type { LeftSidebarHandle } from "../features/media/LeftSidebar";
import { STUDIO_MOTION_PATH } from "../features/animation/studioMotion";
import { isApplicationControlKey, isTypingTarget } from "../lib/typingTarget";
import { shouldBlockChromeSelection, shouldBlockNativeGhostDrag } from "../lib/editorDefaultInteractions";
import { isEditableTarget } from "../features/timeline/timelineDiscovery";
import { useCaptionStore } from "../captions/store";
import {
  applyCaptionModelToIframe,
  isCaptionPreviewVisible,
} from "../captions/components/CaptionOverlayUtils";
import { shouldIgnoreHistoryShortcut } from "../lib/studioHelpers";
import { trackStudioEvent } from "../lib/studioTelemetry";
import { serializeStudioFileMutations } from "../features/history/studioFileMutationCoordinator";
import { applyDurableStudioHistoryTransaction, type StudioHistoryTransactionInput } from "../features/history/studioFileTransaction";
import { studioFileContentVersion } from "../features/history/studioFileVersion";
import type { ApplyCallbacks } from "../features/history/usePersistentEditHistory";
import { dispatchPlainKey } from "./dispatchPlainAppKey";

function iframeContentWindow(iframe: HTMLIFrameElement | null): Window | null {
  try {
    return iframe?.contentWindow ?? null;
  } catch {
    return null;
  }
}

function safeAddListener(t: EventTarget | null, type: string, h: EventListener, capture = false) {
  try {
    t?.addEventListener(type, h, capture);
  } catch {
    /* cross-origin */
  }
}
function safeRemoveListener(t: EventTarget | null, type: string, h: EventListener, capture = false) {
  try {
    t?.removeEventListener(type, h, capture);
  } catch {
    /* cross-origin */
  }
}

// fallow-ignore-next-line complexity
function handleUndoRedoKey(event: KeyboardEvent, onUndo: () => void, onRedo: () => void): boolean {
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) {
    event.preventDefault();
    onUndo();
    return true;
  }
  if ((key === "z" && event.shiftKey) || (event.ctrlKey && !event.metaKey && key === "y")) {
    event.preventDefault();
    onRedo();
    return true;
  }
  return false;
}

// Beat edits live in an in-memory stack interleaved with file history by
// timestamp. Undo steps to the NEWER op (beatAt >= fileAt); redo replays the
// inverse, stepping to the OLDER op (beatAt <= fileAt). Returns true when it
// handled the keystroke (so the file-history path is skipped).
// fallow-ignore-next-line complexity
function tryApplyBeatHistory(
  direction: "undo" | "redo",
  fileState: {
    undo: ReadonlyArray<{ createdAt: number }>;
    redo: ReadonlyArray<{ createdAt: number }>;
  },
  showToast: (message: string, tone?: "error" | "info") => void,
): boolean {
  const ps = usePlayerStore.getState();
  const beatStack = direction === "undo" ? ps.beatUndo : ps.beatRedo;
  const beatAt = beatStack[beatStack.length - 1]?.at ?? null;
  if (beatAt === null) return false;
  const fileStack = fileState[direction];
  const fileAt = fileStack[fileStack.length - 1]?.createdAt ?? null;
  if (fileAt !== null && (direction === "undo" ? beatAt < fileAt : beatAt > fileAt)) return false;
  const label = direction === "undo" ? ps.undoBeatEdits() : ps.redoBeatEdits();
  if (label) showToast(`${direction === "undo" ? "Undid" : "Redid"} ${label}`, "info");
  return true;
}

// ── Types ──

interface HistoryResult {
  ok: boolean;
  reason?: string;
  label?: string;
  paths?: string[];
  /** Per-file restored/previous content, used to soft-apply the preview. */
  files?: Record<string, { previous: string; restored: string }>;
}
interface EditHistoryHandle {
  undo: (cb: ApplyCallbacks) => Promise<HistoryResult>;
  redo: (cb: ApplyCallbacks) => Promise<HistoryResult>;
  state: {
    undo: ReadonlyArray<{ createdAt: number }>;
    redo: ReadonlyArray<{ createdAt: number }>;
  };
}

interface UseAppHotkeysParams {
  projectId?: string | null;
  observeProjectFileVersion?: (path: string, version: string | null) => void;
  handleTimelineElementsDelete: (elements: TimelineElement[]) => Promise<void>;
  handleTimelineElementSplit: (element: TimelineElement, splitTime: number) => Promise<void>;
  handleDomEditElementDelete: (
    selection: DomEditSelection,
    options?: { expandGroup?: boolean },
  ) => Promise<void>;
  domEditSelectionRef: React.MutableRefObject<DomEditSelection | null>;
  clearDomSelectionRef: React.MutableRefObject<() => void>;
  editHistory: EditHistoryHandle;
  readOptionalProjectFile: (path: string) => Promise<string>;
  readProjectFile: (path: string) => Promise<string>;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  domEditSaveTimestampRef: React.MutableRefObject<number>;
  showToast: (message: string, tone?: "error" | "info") => void;
  syncHistoryPreviewAfterApply: (restore: {
    paths?: string[];
    files?: Record<string, { previous: string; restored: string }>;
  }) => Promise<void>;
  waitForPendingDomEditSaves: () => Promise<void>;
  leftSidebarRef: React.RefObject<LeftSidebarHandle | null>;
  handleCopy: () => boolean;
  handlePaste: () => Promise<void>;
  handleCut: () => Promise<boolean>;
  handleDuplicate?: () => boolean;
  onResetKeyframes: () => boolean | Promise<boolean>;
  onDeleteSelectedKeyframes: () => void | Promise<boolean>;
  onAfterUndoRedo?: () => void;
  onToggleRecording?: () => void;
  /** Group the current multi-selection into a data-hf-group wrapper (⌘G). */
  onGroupSelection?: () => void;
  /** Ungroup the selected group wrapper (⌘⇧G). */
  onUngroupSelection?: () => void;
  /** Active composition path — used to decide whether undo/redo must resync the SDK session. */
  activeCompPath?: string | null;
  /**
   * Force-reload the SDK session after undo/redo reverts the active comp file,
   * bypassing the self-write suppress window. Without this, the suppress window
   * blocks the file-change reload and the SDK session stays on pre-undo content.
   */
  forceReloadSdkSession?: () => void;
}

// ── Extracted keydown dispatch (pure function, no hooks) ──

export interface HotkeyCallbacks {
  handleTimelineElementsDelete: (elements: TimelineElement[]) => Promise<void>;
  handleTimelineElementSplit: (element: TimelineElement, splitTime: number) => Promise<void>;
  handleDomEditElementDelete: (
    selection: DomEditSelection,
    options?: { expandGroup?: boolean },
  ) => Promise<void>;
  handleUndo: () => Promise<void>;
  handleRedo: () => Promise<void>;
  handleCopy: () => boolean;
  handlePaste: () => Promise<void>;
  handleCut: () => Promise<boolean>;
  handleDuplicate?: () => boolean;
  onResetKeyframes: () => boolean | Promise<boolean>;
  onDeleteSelectedKeyframes: () => void | Promise<boolean>;
  onToggleRecording?: () => void;
  onGroupSelection?: () => void;
  onUngroupSelection?: () => void;
  leftSidebarRef: React.RefObject<LeftSidebarHandle | null>;
  domEditSelectionRef: React.MutableRefObject<DomEditSelection | null>;
  showToast: (message: string, tone?: "error" | "info") => void;
}

/** Exported for tests, like dispatchPlainKey below: lets the Cmd+C/Cmd+V
 *  arbitration between an automation range and the clip clipboard be asserted
 *  without standing up the whole hook. */
export function dispatchModifierKey(
  event: KeyboardEvent,
  key: string,
  cb: HotkeyCallbacks,
): boolean {
  if (
    !shouldIgnoreHistoryShortcut(event.target) &&
    handleUndoRedoKey(
      event,
      () => {
        trackStudioEvent("keyboard_shortcut", { action: "undo" });
        void cb.handleUndo();
      },
      () => {
        trackStudioEvent("keyboard_shortcut", { action: "redo" });
        void cb.handleRedo();
      },
    )
  )
    return true;

  if (event.key === "1") {
    event.preventDefault();
    trackStudioEvent("keyboard_shortcut", { action: "tab_compositions" });
    cb.leftSidebarRef.current?.selectTab("compositions");
    return true;
  }
  if (event.key === "2") {
    event.preventDefault();
    trackStudioEvent("keyboard_shortcut", { action: "tab_assets" });
    cb.leftSidebarRef.current?.selectTab("assets");
    return true;
  }

  if (key === "a" && !event.shiftKey && !event.altKey && !isTypingTarget(event.target)) {
    // Browser Select All highlights the entire app (and the preview document).
    // In the timeline, Select All has the expected clip meaning instead.
    event.preventDefault();
    const target = event.target as Element | null;
    if (target && typeof target.closest === "function" && target.closest('[aria-label="Timeline"]')) {
      const store = usePlayerStore.getState();
      const ids = store.elements.map((element) => element.key ?? element.id);
      if (ids.length > 0) {
        store.setSelectedElementId(ids[0]);
        store.setSelectedElementIds(new Set(ids));
      }
    }
    return true;
  }

  if (key === "g" && !event.altKey && !isTypingTarget(event.target)) {
    event.preventDefault();
    if (event.shiftKey) cb.onUngroupSelection?.();
    else cb.onGroupSelection?.();
    return true;
  }

  if (key === "d" && !event.shiftKey && !event.altKey && !isEditableTarget(event.target) && cb.handleDuplicate) {
    event.preventDefault();
    if (cb.handleDuplicate()) trackStudioEvent("keyboard_shortcut", { action: "duplicate" });
    return true;
  }

  if (!event.shiftKey && !event.altKey && !isEditableTarget(event.target)) {
    // An active automation range owns Cmd+C/Cmd+V, the same way it owns Delete
    // below. This listener is on window/capture and runs before
    // useAutomationSelectionKeyboard's document/capture handler, so without
    // this the clip clipboard also claimed the key: Cmd+V duplicated the clip
    // while the automation paste wrote the same file, and Cmd+C armed both
    // clipboards and toasted "Copied clip". Return without preventDefault so
    // the downstream handler still sees the key.
    if (automationOwnsKey(event)) return true;
    if (key === "c") {
      if (cb.handleCopy()) {
        event.preventDefault();
        trackStudioEvent("keyboard_shortcut", { action: "copy" });
      }
      return true;
    }
    if (key === "v") {
      event.preventDefault();
      trackStudioEvent("keyboard_shortcut", { action: "paste" });
      void cb.handlePaste();
      return true;
    }
    if (key === "x") {
      if (usePlayerStore.getState().selectedElementId || cb.domEditSelectionRef.current) {
        event.preventDefault();
        trackStudioEvent("keyboard_shortcut", { action: "cut" });
        void cb.handleCut();
      }
      return true;
    }
  }
  return false;
}

export { dispatchPlainKey } from "./dispatchPlainAppKey";

// ── Hook ──

export function useAppHotkeys({
  projectId,
  observeProjectFileVersion,
  handleTimelineElementsDelete,
  handleTimelineElementSplit,
  handleDomEditElementDelete,
  domEditSelectionRef,
  editHistory,
  readOptionalProjectFile,
  readProjectFile,
  writeProjectFile,
  domEditSaveTimestampRef,
  showToast,
  syncHistoryPreviewAfterApply,
  waitForPendingDomEditSaves,
  leftSidebarRef,
  handleCopy,
  handlePaste,
  handleCut,
  handleDuplicate,
  onResetKeyframes,
  onDeleteSelectedKeyframes,
  onAfterUndoRedo,
  onToggleRecording,
  onGroupSelection,
  onUngroupSelection,
  activeCompPath,
  forceReloadSdkSession,
}: UseAppHotkeysParams) {
  const previewHistoryCleanupRef = useRef<(() => void) | null>(null);
  const historyMountedRef = useRef(true);
  const historyScopeRef = useRef({ projectId, activeCompPath });
  if (
    historyScopeRef.current.projectId !== projectId ||
    historyScopeRef.current.activeCompPath !== activeCompPath
  ) {
    historyScopeRef.current = { projectId, activeCompPath };
  }
  const historyScope = historyScopeRef.current;
  const historyScopeIsCurrent = useCallback(
    () => historyMountedRef.current && historyScopeRef.current === historyScope,
    [historyScope],
  );
  useEffect(() => {
    historyMountedRef.current = true;
    return () => { historyMountedRef.current = false; };
  }, []);

  // ── Undo / Redo ──

  const readHistoryFile = useCallback(
    (path: string): Promise<string> =>
      path === STUDIO_MOTION_PATH ? readOptionalProjectFile(path) : readProjectFile(path),
    [readOptionalProjectFile, readProjectFile],
  );
  const writeHistoryFile = useCallback(
    async (path: string, content: string): Promise<void> => {
      domEditSaveTimestampRef.current = Date.now();
      await writeProjectFile(path, content);
    },
    [domEditSaveTimestampRef, writeProjectFile],
  );
  const serializeHistoryFiles = useCallback(
    <T>(paths: readonly string[], task: () => Promise<T>) =>
      serializeStudioFileMutations(writeProjectFile, paths, task),
    [writeProjectFile],
  );
  const applyHistoryTransaction = useCallback(async (input: StudioHistoryTransactionInput) => {
    if (!projectId) throw new Error("No active project for Undo/Redo");
    domEditSaveTimestampRef.current = Date.now();
    const applied = await applyDurableStudioHistoryTransaction({ ...input, projectId });
    for (const file of input.files) {
      observeProjectFileVersion?.(file.path, file.after === null ? null : await studioFileContentVersion(file.after));
    }
    return applied;
  }, [domEditSaveTimestampRef, observeProjectFileVersion, projectId]);

  const applyHistory = useCallback(
    async (direction: "undo" | "redo") => {
      if (!historyScopeIsCurrent()) return;
      // Caption edits live in their own in-memory stack. While caption edit
      // mode is active, ⌘Z must revert the caption edit — not an unrelated
      // earlier file edit (which would ALSO leave the caption change intact).
      const captionState = useCaptionStore.getState();
      // Only when the caption preview is actually visible: isEditMode stays
      // true while the preview is hidden, and eating ⌘Z
      // there would pop invisible caption edits instead of file history.
      if (captionState.isEditMode && isCaptionPreviewVisible()) {
        const restored = direction === "undo" ? captionState.undo() : captionState.redo();
        if (restored) {
          applyCaptionModelToIframe(restored);
          showToast(`${direction === "undo" ? "Undid" : "Redid"} caption edit`, "info");
          return;
        }
        // Empty caption stack: fall through to beat/file history as usual.
      }

      // Beat edits interleave with file history by timestamp; handle them first.
      if (tryApplyBeatHistory(direction, editHistory.state, showToast)) return;

      await waitForPendingDomEditSaves();
      if (!historyScopeIsCurrent()) return;
      let result: HistoryResult;
      try {
        result = await editHistory[direction]({
          readFile: readHistoryFile,
          writeFile: writeHistoryFile,
          serialize: serializeHistoryFiles,
          ...(projectId ? { applyTransaction: applyHistoryTransaction } : {}),
        });
      } catch (error) {
        if (historyScopeIsCurrent()) {
          showToast(error instanceof Error ? error.message : `Could not ${direction} this edit`, "error");
        }
        return;
      }
      // A durable history operation may finish for its original project after
      // navigation. Its preview callbacks use current refs, so they must never
      // apply that result to the newly active project or composition.
      if (!historyScopeIsCurrent()) return;
      if (!result.ok && result.reason === "content-mismatch") {
        showToast(
          `File changed outside Studio. ${direction === "undo" ? "Undo" : "Redo"} history was not applied.`,
          "info",
        );
        return;
      }
      if (result.ok && result.label) {
        onAfterUndoRedo?.();
        // If the active composition was among the written files, force-reload
        // the SDK session so its in-memory doc matches the reverted content.
        // writeHistoryFile sets domEditSaveTimestampRef which activates the
        // 2 s suppress window — without this call the file-change event would
        // be swallowed and the SDK session would stay on stale pre-undo content.
        if (activeCompPath && result.paths?.includes(activeCompPath)) {
          forceReloadSdkSession?.();
        }
        await syncHistoryPreviewAfterApply({ paths: result.paths, files: result.files });
        if (!historyScopeIsCurrent()) return;
        showToast(`${direction === "undo" ? "Undid" : "Redid"} ${result.label}`, "info");
      }
    },
    [
      editHistory,
      historyScopeIsCurrent,
      readHistoryFile,
      showToast,
      syncHistoryPreviewAfterApply,
      waitForPendingDomEditSaves,
      writeHistoryFile,
      serializeHistoryFiles,
      applyHistoryTransaction,
      projectId,
      onAfterUndoRedo,
      activeCompPath,
      forceReloadSdkSession,
    ],
  );

  const handleUndo = useCallback(() => applyHistory("undo"), [applyHistory]);
  const handleRedo = useCallback(() => applyHistory("redo"), [applyHistory]);

  // ── Stable callback ref (one ref replaces fifteen) ──

  const cbRef = useRef<HotkeyCallbacks>(null!);
  cbRef.current = {
    handleTimelineElementsDelete,
    handleTimelineElementSplit,
    handleDomEditElementDelete,
    handleUndo,
    handleRedo,
    handleCopy,
    handlePaste,
    handleCut,
    handleDuplicate,
    onResetKeyframes,
    onDeleteSelectedKeyframes,
    onToggleRecording,
    onGroupSelection,
    onUngroupSelection,
    leftSidebarRef,
    domEditSelectionRef,
    showToast,
  };

  // ── Keydown dispatch ──

  const handleAppKeyDown = useCallback((event: KeyboardEvent) => {
    if (isApplicationControlKey(event)) return;
    const cb = cbRef.current;
    const key = event.key.toLowerCase();
    if (event.metaKey || event.ctrlKey) {
      dispatchModifierKey(event, key, cb);
      return;
    }
    if (!isTypingTarget(event.target)) dispatchPlainKey(event, key, cb);
  }, []);

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    window.addEventListener("keydown", handleAppKeyDown, true);
    return () => window.removeEventListener("keydown", handleAppKeyDown, true);
  }, [handleAppKeyDown]);

  // ── Preview iframe forwarding ──

  /**
   * Give the preview iframe the app's hotkeys, because a keypress lands in
   * whichever document has focus and clicking the canvas puts focus in there.
   *
   * Must run on every iframe LOAD, not once when the element mounts: a reload
   * keeps the same element (so no ref callback) and the same WindowProxy (so an
   * identity check sees no change) while replacing the inner window that holds
   * the listeners. The general dispatcher owns history as well as editing keys;
   * adding separate window/document history listeners applies one Undo three times.
   */
  const syncPreviewHotkeys = useCallback(
    (iframe: HTMLIFrameElement | null) => {
      previewHistoryCleanupRef.current?.();
      previewHistoryCleanupRef.current = null;
      const win = iframeContentWindow(iframe);
      if (!win) return;
      const appHandler = handleAppKeyDown as EventListener;
      safeAddListener(win, "keydown", appHandler, true);
      let doc: Document | null = null;
      try { doc = win.document; } catch { /* cross-origin preview */ }
      const blockSelection = (event: Event) => {
        if (shouldBlockChromeSelection(event.target)) event.preventDefault();
      };
      const blockGhostDrag = (event: Event) => {
        if (shouldBlockNativeGhostDrag(event.target)) event.preventDefault();
      };
      safeAddListener(doc, "selectstart", blockSelection, true);
      safeAddListener(doc, "dragstart", blockGhostDrag, true);
      previewHistoryCleanupRef.current = () => {
        safeRemoveListener(win, "keydown", appHandler, true);
        safeRemoveListener(doc, "selectstart", blockSelection, true);
        safeRemoveListener(doc, "dragstart", blockGhostDrag, true);
      };
    },
    [handleAppKeyDown],
  );

  useEffect(
    () => () => {
      previewHistoryCleanupRef.current?.();
      previewHistoryCleanupRef.current = null;
    },
    [],
  );

  return {
    handleUndo,
    handleRedo,
    syncPreviewHotkeys,
  };
}
