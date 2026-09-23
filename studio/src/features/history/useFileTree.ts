import { desktopRequest } from "../../lib/desktopClient";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { FONT_EXT } from "../media/mediaTypes";
import { fontFamilyFromAssetPath, type ImportedFontAsset } from "../inspector/fontAssets";
import { captureProjectProvenance } from "../feedback/projectProvenance";

interface UseFileTreeOptions {
  projectId: string | null;
  projectIdRef: React.RefObject<string | null>;
}

export function useFileTree({ projectId, projectIdRef }: UseFileTreeOptions) {
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [fileTree, setFileTree] = useState<string[]>([]);
  const [compositionPaths, setCompositionPaths] = useState<string[]>([]);
  const [fileTreeLoaded, setFileTreeLoaded] = useState(false);
  const listingGeneration = useRef(0);

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const generation = ++listingGeneration.current;
    if (!projectId) {
      setFileTreeLoaded(false);
      return;
    }
    let cancelled = false;
    setFileTreeLoaded(false);
    desktopRequest(`/api/projects/${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((data: { files?: string[]; dir?: string; compositions?: string[] }) => {
        if (cancelled || generation !== listingGeneration.current) return;
        if (data.files) setFileTree(data.files);
        if (data.compositions) setCompositionPaths(data.compositions);
        setProjectDir(typeof data.dir === "string" ? data.dir : null);
        // Snapshot aggregate project size while the listing is already in hand.
        captureProjectProvenance(projectId, data.files ?? [], data.compositions ?? []);
      })
      .catch(() => {
        if (!cancelled && generation === listingGeneration.current) setProjectDir(null);
      })
      .finally(() => {
        if (!cancelled) setFileTreeLoaded(true);
      });
    return () => {
      cancelled = true;
      listingGeneration.current += 1;
    };
  }, [projectId]);

  const refreshFileTree = useCallback(async () => {
    const pid = projectIdRef.current;
    if (!pid) return;
    const generation = ++listingGeneration.current;
    const res = await desktopRequest(`/api/projects/${encodeURIComponent(pid)}`);
    if (!res.ok) throw new Error(`Failed to refresh project files (${res.status})`);
    const data = (await res.json()) as {
      files?: string[];
      compositions?: string[];
      dir?: string;
    };
    if (projectIdRef.current !== pid || generation !== listingGeneration.current) return;
    if (data.files) setFileTree(data.files);
    if (data.compositions) setCompositionPaths(data.compositions);
    if (typeof data.dir === "string") setProjectDir(data.dir);
  }, [projectIdRef]);

  const removeProjectPath = useCallback((path: string) => {
    // A listing started before the committed deletion cannot reintroduce it.
    listingGeneration.current += 1;
    setFileTree((current) => current.filter((candidate) => candidate !== path));
    setCompositionPaths((current) => current.filter((candidate) => candidate !== path));
  }, []);

  const compositions = compositionPaths;

  const assets = useMemo(
    () =>
      fileTree.filter((f) =>
        !f.endsWith(".html") && !f.endsWith(".md") && !f.endsWith(".json") &&
        // Undo archives remain on disk and in the file listing, but are not
        // live media. Otherwise deleting a file simply re-adds its backup card.
        !f.split("/").includes(".hyperframes"),
      ),
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
