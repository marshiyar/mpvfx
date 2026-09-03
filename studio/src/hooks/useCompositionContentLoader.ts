import { useCallback } from "react";

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
  return useCallback(
    (comp: string) => {
      setActiveCompPath(comp.endsWith(".html") ? comp : null);
      setEditingFile({ path: comp, content: null });
      fetch(`/api/projects/${projectId}/files/${comp}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`Failed to load ${comp} (${r.status})`);
          return r.json();
        })
        .then((data: { content?: string }) => {
          if (typeof data.content !== "string") throw new Error(`No content returned for ${comp}`);
          setEditingFile({ path: comp, content: data.content });
        })
        .catch((err) => {
          showToast(err instanceof Error ? err.message : `Failed to load ${comp}`, "error");
        });
    },
    [projectId, setEditingFile, setActiveCompPath, showToast],
  );
}
