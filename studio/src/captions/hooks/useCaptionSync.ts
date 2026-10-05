import { desktopRequest } from "../../lib/desktopClient";
import { useCallback, useRef } from "react";
import { addStudioPendingEditFlushListener, trackStudioPendingEdit } from "../../features/history/studioPendingEdits";
import { useCaptionStore } from "../store";
import { useMountEffect } from "../../app/useMountEffect";
import { trackEvent } from "../../telemetry/client";
import type { CaptionStyle } from "../types";
import { studioWriteHeaders } from "../../features/history/studioFileVersion";

interface CaptionOverrideEntry {
  wordId?: string;
  wordIndex: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  activeColor?: string;
  dimColor?: string;
  opacity?: number;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
}

function buildOverrides(model: {
  groupOrder: string[];
  groups: Map<string, { segmentIds: string[] }>;
  segments: Map<string, { wordId?: string; style: Partial<CaptionStyle> }>;
}): CaptionOverrideEntry[] {
  const entries: CaptionOverrideEntry[] = [];
  let globalWordIndex = 0;

  for (const groupId of model.groupOrder) {
    const group = model.groups.get(groupId);
    if (!group) continue;
    for (const segId of group.segmentIds) {
      const seg = model.segments.get(segId);
      if (seg && Object.keys(seg.style).length > 0) {
        const entry: CaptionOverrideEntry = { wordIndex: globalWordIndex };
        if (seg.wordId) entry.wordId = seg.wordId;
        const s = seg.style;
        if (s.x !== undefined) entry.x = s.x;
        if (s.y !== undefined) entry.y = s.y;
        if (s.scaleX !== undefined) entry.scale = s.scaleX;
        if (s.rotation !== undefined) entry.rotation = s.rotation;
        if (s.activeColor !== undefined) entry.activeColor = s.activeColor;
        if (s.dimColor !== undefined) entry.dimColor = s.dimColor;
        if (s.opacity !== undefined) entry.opacity = s.opacity;
        if (s.fontSize !== undefined) entry.fontSize = s.fontSize;
        if (s.fontWeight !== undefined) entry.fontWeight = s.fontWeight as number;
        if (s.fontFamily !== undefined) entry.fontFamily = s.fontFamily;
        entries.push(entry);
      }
      globalWordIndex++;
    }
  }

  return entries;
}

/**
 * Auto-saves caption overrides to caption-overrides.json on every model change.
 * Also provides loadOverrides for reading existing overrides on edit mode entry.
 */
export function useCaptionSync(projectId: string | null) {
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flag to suppress auto-save during loadOverrides
  const suppressSaveRef = useRef(false);

  const pendingRef = useRef(new Map<string, { projectId: string; sourceFile: string; body: string }>());
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lifetimeRef = useRef({ alive: true, generation: 0 });

  // Capture the edited bytes and their project before a switch can reset the store.
  const save = useCallback((): Promise<void> => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    if (inFlightRef.current) return inFlightRef.current;
    const operation = (async () => {
      while (pendingRef.current.size) {
        const [key, edit] = pendingRef.current.entries().next().value!;
        try {
          const response = await desktopRequest(`/api/projects/${encodeURIComponent(edit.projectId)}/files/caption-overrides.json`, {
            method: "PUT",
            headers: { "Content-Type": "text/plain", ...studioWriteHeaders() },
            body: edit.body,
          });
          if (!response.ok) throw new Error(`Caption save failed (${response.status})`);
          if (pendingRef.current.get(key) === edit) pendingRef.current.delete(key);
          if (projectIdRef.current === edit.projectId && lifetimeRef.current.alive) useCaptionStore.getState().setSyncError(null);
        } catch (error) {
          trackEvent("studio_caption_autosave_failed", { error: String(error) });
          if (projectIdRef.current === edit.projectId && lifetimeRef.current.alive) useCaptionStore.getState().setSyncError("Caption changes couldn't be saved");
          throw error;
        }
      }
    })();
    inFlightRef.current = operation;
    const clear = () => { if (inFlightRef.current === operation) inFlightRef.current = null; };
    void operation.then(clear, clear);
    trackStudioPendingEdit(operation);
    return operation;
  }, []);
  const saveForUi = useCallback(() => { void save().catch(() => {}); }, [save]);

  useMountEffect(() => {
    lifetimeRef.current.alive = true;
    let prevModel = useCaptionStore.getState().model;
    const unsub = useCaptionStore.subscribe((state) => {
      const changed = state.model !== prevModel;
      prevModel = state.model;
      if (!state.isEditMode || !changed || !state.model || !state.sourceFilePath) return;
      if (suppressSaveRef.current) { suppressSaveRef.current = false; return; }
      const pid = projectIdRef.current;
      if (!pid) return;
      const key = JSON.stringify([pid, state.sourceFilePath]);
      pendingRef.current.set(key, { projectId: pid, sourceFile: state.sourceFilePath, body: JSON.stringify(buildOverrides(state.model), null, 2) });
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(saveForUi, 800);
    });
    const removeFlush = addStudioPendingEditFlushListener(save);
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!pendingRef.current.size && !inFlightRef.current) return;
      saveForUi();
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    useCaptionStore.getState().setRetrySave(saveForUi);
    return () => {
      lifetimeRef.current.alive = false;
      lifetimeRef.current.generation++;
      unsub();
      removeFlush();
      window.removeEventListener("beforeunload", handleBeforeUnload);
      saveForUi();
      useCaptionStore.getState().setRetrySave(null);
    };
  });

  const loadOverrides = useCallback(async () => {
    const state = useCaptionStore.getState();
    if (!state.model || !state.sourceFilePath) return;
    const pid = projectIdRef.current;
    if (!pid) return;

    const generation = ++lifetimeRef.current.generation;
    const isCurrent = () => lifetimeRef.current.alive && lifetimeRef.current.generation === generation &&
      projectIdRef.current === pid && useCaptionStore.getState().model === state.model &&
      useCaptionStore.getState().sourceFilePath === state.sourceFilePath;
    let data: { content?: string };
    try {
      const res = await desktopRequest(
        `/api/projects/${pid}/files/${encodeURIComponent("caption-overrides.json")}`,
      );
      if (!res.ok) return; // no overrides file yet — normal
      data = await res.json();
    } catch {
      return; // network failure fetching an optional file — nothing to restore
    }
    if (!data.content || !isCurrent()) return;

    try {
      const overrides: CaptionOverrideEntry[] = JSON.parse(data.content);
      if (!Array.isArray(overrides)) throw new Error("not an array");

      const model = state.model;
      const allSegIds: string[] = [];
      const segIdByWordId = new Map<string, string>();
      for (const groupId of model.groupOrder) {
        const group = model.groups.get(groupId);
        if (!group) continue;
        for (const segId of group.segmentIds) {
          allSegIds.push(segId);
          const seg = model.segments.get(segId);
          if (seg?.wordId) segIdByWordId.set(seg.wordId, segId);
        }
      }

      const newSegments = new Map(model.segments);
      for (const override of overrides) {
        const segId =
          (override.wordId ? segIdByWordId.get(override.wordId) : undefined) ??
          allSegIds[override.wordIndex];
        if (!segId) continue;
        const seg = newSegments.get(segId);
        if (!seg) continue;

        const style: Partial<CaptionStyle> = { ...seg.style };
        if (override.x !== undefined) style.x = override.x;
        if (override.y !== undefined) style.y = override.y;
        if (override.scale !== undefined) {
          style.scaleX = override.scale;
          style.scaleY = override.scale;
        }
        if (override.rotation !== undefined) style.rotation = override.rotation;
        if (override.activeColor !== undefined) style.activeColor = override.activeColor;
        if (override.dimColor !== undefined) style.dimColor = override.dimColor;
        if (override.opacity !== undefined) style.opacity = override.opacity;
        if (override.fontSize !== undefined) style.fontSize = override.fontSize;
        if (override.fontWeight !== undefined) style.fontWeight = override.fontWeight;
        if (override.fontFamily !== undefined) style.fontFamily = override.fontFamily;

        newSegments.set(segId, { ...seg, style });
      }

      if (!isCurrent()) return;
      suppressSaveRef.current = true;
      useCaptionStore.getState().setModel({ ...model, segments: newSegments });
    } catch {
      if (!isCurrent()) return;
      // File exists but is unreadable — previous edits would silently not load.
      useCaptionStore
        .getState()
        .setSyncError("caption-overrides.json is corrupt — earlier caption edits didn't load");
    }
  }, []);

  return { save, loadOverrides };
}
