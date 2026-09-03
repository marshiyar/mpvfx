import { useState, useCallback, useEffect, useMemo } from "react";
import { FONT_EXT } from "../utils/mediaTypes";
import { fontFamilyFromAssetPath, type ImportedFontAsset } from "../components/editor/fontAssets";
import { captureProjectProvenance } from "../components/feedback/projectProvenance";

interface UseFileTreeOptions {
  projectId: string | null;
  projectIdRef: React.RefObject<string | null>;
}

export function useFileTree({ projectId, projectIdRef }: UseFileTreeOptions) {
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<string[]>([]);
  const [compositionPaths, setCompositionPaths] = useState<string[]>([]);
  const [fileTreeLoaded, setFileTreeLoaded] = useState(false);

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!projectId) {
      setFileTreeLoaded(false);
      return;
    }
    let cancelled = false;
    setFileTreeLoaded(false);
    fetch(`/api/projects/${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((data: { files?: string[]; dir?: string; compositions?: string[] }) => {
        if (cancelled) return;
        if (data.files) setFileTree(data.files);
        if (data.compositions) setCompositionPaths(data.compositions);
        setProjectDir(typeof data.dir === "string" ? data.dir : null);
        // Snapshot aggregate project size while the listing is already in hand.
        captureProjectProvenance(projectId, data.files ?? [], data.compositions ?? []);
      })
      .catch(() => {
        if (!cancelled) setProjectDir(null);
      })
      .finally(() => {
        if (!cancelled) setFileTreeLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const refreshFileTree = useCallback(async () => {
    const pid = projectIdRef.current;
    if (!pid) return;
    const res = await fetch(`/api/projects/${encodeURIComponent(pid)}`);
    if (!res.ok) throw new Error(`Failed to refresh project files (${res.status})`);
    const data = (await res.json()) as {
      files?: string[];
      compositions?: string[];
      dir?: string;
    };
    if (projectIdRef.current !== pid) return;
    if (data.files) setFileTree(data.files);
    if (data.compositions) setCompositionPaths(data.compositions);
    if (typeof data.dir === "string") setProjectDir(data.dir);
  }, [projectIdRef]);

  const removeProjectPath = useCallback((path: string) => {
    setFileTree((current) => current.filter((candidate) => candidate !== path));
    setCompositionPaths((current) => current.filter((candidate) => candidate !== path));
  }, []);

  const compositions = compositionPaths;

  const assets = useMemo(
    () =>
      fileTree.filter((f) => !f.endsWith(".html") && !f.endsWith(".md") && !f.endsWith(".json")),
    [fileTree],
  );

  const fontAssets = useMemo<ImportedFontAsset[]>(
    () =>
      assets
        .filter((asset) => FONT_EXT.test(asset))
        .map((asset) => ({
          family: fontFamilyFromAssetPath(asset),
          path: asset,
          url: `/api/projects/${projectId}/preview/${asset}`,
        })),
    [assets, projectId],
  );

  return {
    projectDir,
    fileTree,
    fileTreeLoaded,
    refreshFileTree,
    removeProjectPath,
    compositions,
    assets,
    fontAssets,
  };
}
