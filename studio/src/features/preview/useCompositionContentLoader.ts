import { desktopRequest } from "../../lib/desktopClient";
import { useCallback, useEffect, useRef } from "react";
import { encodeMediaPath } from "../../../shared/media/mediaUrl";

/**
 * Loads a selected composition so the preview, timeline, and visual inspector
 * share the same document. Load failures surface as an error toast.
 */
export function useCompositionContentLoader({
  projectId,
  setEditingFile,
  setActiveCompPath,
  showToast,
}: {
  projectId: string | null;
  setEditingFile: (file: { path: string; content: string | null }) => void;
  setActiveCompPath: (path: string | null) => void;
  showToast: (message: string, tone?: "error" | "info") => void;
}) {
  const scope = useRef({ projectId, generation: 0, alive: true });
  if (scope.current.projectId !== projectId) scope.current = { projectId, generation: 0, alive: true };
  useEffect(() => {
    const current = scope.current;
    current.alive = true;
    return () => { current.alive = false; current.generation++; };
  }, [projectId]);
  return useCallback(
    (comp: string) => {
      if (!projectId) return;
      const current = scope.current;
      const generation = ++current.generation;
      const isCurrent = () => current === scope.current && current.alive && current.generation === generation;
      setActiveCompPath(comp.endsWith(".html") ? comp : null);
      setEditingFile({ path: comp, content: null });
      desktopRequest(`/api/projects/${encodeURIComponent(projectId)}/files/${encodeMediaPath(comp)}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`Failed to load ${comp} (${r.status})`);
          return r.json();
        })
        .then((data: { content?: string }) => {
          if (typeof data.content !== "string") throw new Error(`No content returned for ${comp}`);
          if (isCurrent()) setEditingFile({ path: comp, content: data.content });
        })
        .catch((err) => {
          if (isCurrent()) showToast(err instanceof Error ? err.message : `Failed to load ${comp}`, "error");
        });
    },
    [projectId, setEditingFile, setActiveCompPath, showToast],
  );
}
