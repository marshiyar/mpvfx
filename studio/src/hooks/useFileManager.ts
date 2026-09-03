import { useState, useCallback, useMemo, useRef } from "react";
import type { EditingFile } from "../utils/studioHelpers";
import { FONT_EXT } from "../utils/mediaTypes";
import { partitionMediaImportFiles } from "../utils/mediaImportPolicy";
import { fontFamilyFromAssetPath, type ImportedFontAsset } from "../components/editor/fontAssets";
import {
  createStudioSaveHttpError,
  retryStudioSave,
  StudioFileConflictError,
  StudioSaveNetworkError,
} from "../utils/studioSaveDiagnostics";
import { studioExpectedFileVersion, studioWriteHeaders } from "../utils/studioFileVersion";
import { useFileTree } from "./useFileTree";

interface UseFileManagerOptions {
  projectId: string | null;
  showToast: (message: string, tone?: "error" | "info") => void;
  setRefreshKey: React.Dispatch<React.SetStateAction<number>>;
}

// ── Hook ──

export function useFileManager({
  projectId,
  showToast,
  setRefreshKey,
}: UseFileManagerOptions) {
  // ── Shared refs ──

  const [editingFile, setEditingFile] = useState<EditingFile | null>(null);
  const editingPathRef = useRef(editingFile?.path);
  editingPathRef.current = editingFile?.path;

  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const importedFontAssetsRef = useRef<ImportedFontAsset[]>([]);
  const fileVersionScope = useMemo(
    () => ({ projectId, versions: new Map<string, string | null>() }),
    [projectId],
  );
  const fileVersions = fileVersionScope.versions;
  const observeProjectFileVersion = useCallback(
    (path: string, version: string | null) => {
      fileVersions.set(path, version);
    },
    [fileVersions],
  );

  // ── File tree ──

  const {
    projectDir,
    fileTree,
    fileTreeLoaded,
    refreshFileTree,
    removeProjectPath,
    compositions,
    assets,
    fontAssets,
  } = useFileTree({ projectId, projectIdRef });

  // ── Core file I/O ──

  const readProjectFile = useCallback(
    async (path: string): Promise<string> => {
      if (!projectId) throw new Error("No active project");
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(path)}`,
      );
      if (!response.ok) throw new Error(`Failed to read ${path}`);
      const data = (await response.json()) as { content?: string; version?: string };
      if (typeof data.content !== "string") throw new Error(`Missing file contents for ${path}`);
      fileVersions.set(path, data.version ?? response.headers.get("etag"));
      return data.content;
    },
    [fileVersions, projectId],
  );

  const writeProjectFile = useCallback(
    async (path: string, content: string, expectedContent?: string): Promise<void> => {
      if (!projectId) throw new Error("No active project");
      const writeProjectId = projectId;
      let expectedVersion = await studioExpectedFileVersion(fileVersions, path, expectedContent);
      if (expectedVersion === undefined) {
        const preflight = await fetch(
          `/api/projects/${encodeURIComponent(writeProjectId)}/files/${encodeURIComponent(path)}`,
        );
        if (preflight.ok) {
          const data = (await preflight.json()) as { content?: string; version?: string };
          throw new StudioFileConflictError({
            filePath: path,
            currentVersion: data.version ?? preflight.headers.get("etag"),
            currentContent: data.content ?? null,
            attemptedContent: content,
          });
        } else if (preflight.status === 404) {
          expectedVersion = null;
        } else {
          throw await createStudioSaveHttpError(preflight, `Failed to read ${path} before save`);
        }
      }
      await retryStudioSave(async () => {
        // Each request gets its own receipt identity. If a committed request loses its response,
        // the retry can produce a second filesystem receipt that must be suppressed independently.
        let response: Response;
        try {
          response = await fetch(
            `/api/projects/${encodeURIComponent(writeProjectId)}/files/${encodeURIComponent(path)}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "text/plain",
                ...studioWriteHeaders(),
                ...(expectedVersion ? { "If-Match": expectedVersion } : { "If-None-Match": "*" }),
              },
              body: content,
            },
          );
        } catch (error) {
          throw new StudioSaveNetworkError(`Failed to save ${path}: network error`, {
            cause: error,
          });
        }
        if (response.status === 409) {
          const conflict = (await response.json().catch(() => null)) as {
            currentVersion?: string | null;
            currentContent?: string | null;
          } | null;
          const currentVersion = conflict?.currentVersion ?? null;
          if (currentVersion && conflict?.currentContent === content) {
            fileVersions.set(path, currentVersion);
            return;
          }
          throw new StudioFileConflictError({
            filePath: path,
            currentVersion,
            currentContent: conflict?.currentContent ?? null,
            attemptedContent: content,
          });
        }
        if (!response.ok) throw await createStudioSaveHttpError(response, `Failed to save ${path}`);
        const result = (await response.json()) as { version?: string };
        const version = result.version ?? response.headers.get("etag");
        if (!version)
          throw new Error(`Save response for ${path} did not include a content version`);
        fileVersions.set(path, version);
      });
      if (projectIdRef.current === writeProjectId && editingPathRef.current === path) {
        setEditingFile({ path, content });
      }
    },
    [fileVersions, projectId],
  );

  const updateEditingFileContent = useCallback((path: string, content: string) => {
    if (editingPathRef.current === path) {
      setEditingFile({ path, content });
    }
  }, []);

  const readOptionalProjectFile = useCallback(
    async (path: string): Promise<string> => {
      if (!projectId) throw new Error("No active project");
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(path)}?optional=1`,
      );
      if (!response.ok) throw new Error(`Failed to read ${path}`);
      const data = (await response.json()) as { content?: string; version?: string };
      fileVersions.set(path, data.version ?? response.headers.get("etag"));
      return typeof data.content === "string" ? data.content : "";
    },
    [fileVersions, projectId],
  );

  const overwriteExternalConflict = useCallback(
    async (conflict: StudioFileConflictError) => {
      if (conflict.currentContent != null) {
        await writeProjectFile(
          conflict.filePath,
          conflict.attemptedContent,
          conflict.currentContent,
        );
      } else {
        fileVersions.set(conflict.filePath, conflict.currentVersion);
        await writeProjectFile(conflict.filePath, conflict.attemptedContent);
      }
      updateEditingFileContent(conflict.filePath, conflict.attemptedContent);
    },
    [fileVersions, updateEditingFileContent, writeProjectFile],
  );

  // ── Upload ──

  const uploadProjectFiles = useCallback(
    async (files: Iterable<File>, dir?: string): Promise<string[]> => {
      const pid = projectIdRef.current;
      const fileList = Array.from(files);
      if (!pid || fileList.length === 0) return [];

      const partitioned = partitionMediaImportFiles(fileList);
      if (partitioned.rejected.length > 0) {
        showToast(
          `Unsupported files skipped: ${partitioned.rejected.map(({ file }) => file.name).join(", ")}`,
          "error",
        );
      }
      const acceptedFiles = partitioned.accepted.map(({ file }) => file);
      if (acceptedFiles.length === 0) return [];

      const formData = new FormData();
      for (const file of acceptedFiles) {
        formData.append("file", file);
      }

      const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/upload${qs}`, {
          method: "POST",
          body: formData,
        });
        if (res.ok) {
          let data: {
            files?: unknown;
            skipped?: string[];
            invalid?: Array<{ name: string; reason?: string }>;
          };
          try {
            data = (await res.json()) as typeof data;
          } catch {
            showToast("Upload failed: invalid server response");
            return [];
          }
          if (data.skipped?.length) {
            showToast(`Skipped (too large): ${data.skipped.join(", ")}`);
          }
          if (data.invalid?.length) {
            const names = data.invalid.map((entry: { name: string }) => entry.name).join(", ");
            showToast(`Unsupported media skipped: ${names}`);
          }
          await refreshFileTree();
          setRefreshKey((k) => k + 1);
          return Array.isArray(data.files) ? data.files : [];
        } else if (res.status === 413) {
          showToast("Upload rejected: payload too large");
        } else {
          showToast(`Upload failed (${res.status})`);
        }
      } catch {
        showToast("Upload failed: network error");
      }
      return [];
    },
    [refreshFileTree, setRefreshKey, showToast],
  );

  // ── File CRUD ──

  const handleDeleteFile = useCallback(
    async (path: string) => {
      const pid = projectIdRef.current;
      if (!pid) return;
      const res = await fetch(
        `/api/projects/${encodeURIComponent(pid)}/files/${encodeURIComponent(path)}`,
        {
          method: "DELETE",
        },
      );
      if (res.ok) {
        if (editingPathRef.current === path) setEditingFile(null);
        await refreshFileTree();
      } else {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        console.error(`Delete failed: ${err.error}`);
        showToast(`Couldn't delete ${path}: ${err.error}`, "error");
      }
    },
    [refreshFileTree, showToast],
  );

  const handleDeleteComposition = useCallback(
    async (path: string): Promise<boolean> => {
      const pid = projectIdRef.current;
      if (!pid) return false;
      try {
        const readResponse = await fetch(
          `/api/projects/${encodeURIComponent(pid)}/files/${encodeURIComponent(path)}`,
        );
        if (!readResponse.ok) {
          const error = (await readResponse.json().catch(() => null)) as { error?: string } | null;
          showToast(`Couldn't delete ${path}: ${error?.error ?? "scene not found"}`, "error");
          return false;
        }
        const file = (await readResponse.json()) as { version?: string };
        const expectedVersion = file.version ?? readResponse.headers.get("etag");
        if (!expectedVersion) {
          showToast(`Couldn't delete ${path}: scene version is unavailable`, "error");
          return false;
        }

        const response = await fetch(
          `/api/projects/${encodeURIComponent(pid)}/file-mutations/delete-composition/${encodeURIComponent(path)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedVersion }),
          },
        );
        if (!response.ok) {
          const error = (await response.json().catch(() => null)) as { error?: string } | null;
          showToast(`Couldn't delete ${path}: ${error?.error ?? "unknown error"}`, "error");
          return false;
        }

        if (projectIdRef.current !== pid) return true;
        fileVersions.delete(path);
        removeProjectPath(path);
        if (editingPathRef.current === path) setEditingFile(null);
        try {
          await refreshFileTree();
        } catch {
          showToast(
            `Deleted ${path}, but couldn't refresh the library. Reload to sync.`,
            "error",
          );
        }
        return true;
      } catch {
        showToast(`Couldn't delete ${path}: network error`, "error");
        return false;
      }
    },
    [fileVersions, refreshFileTree, removeProjectPath, showToast],
  );

  const handleRenameFile = useCallback(
    async (oldPath: string, newPath: string) => {
      const pid = projectIdRef.current;
      if (!pid) return;
      const res = await fetch(
        `/api/projects/${encodeURIComponent(pid)}/files/${encodeURIComponent(oldPath)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newPath }),
        },
      );
      if (res.ok) {
        if (editingPathRef.current === oldPath)
          setEditingFile((current) => (current ? { ...current, path: newPath } : current));
        await refreshFileTree();
        setRefreshKey((k) => k + 1);
      } else {
        const err = await res.json().catch(() => ({ error: "unknown" }));
        console.error(`Rename failed: ${err.error}`);
        showToast(`Couldn't rename ${oldPath}: ${err.error}`, "error");
      }
    },
    [refreshFileTree, setRefreshKey, showToast],
  );

  const handleImportFiles = useCallback(
    async (files: FileList | File[], dir?: string) => {
      return uploadProjectFiles(Array.from(files), dir);
    },
    [uploadProjectFiles],
  );

  const handleImportFonts = useCallback(
    async (files: FileList | File[]): Promise<ImportedFontAsset[]> => {
      const pid = projectIdRef.current;
      if (!pid) return [];
      const uploaded = await uploadProjectFiles(
        Array.from(files).filter((file) => FONT_EXT.test(file.name)),
        "assets/fonts",
      );
      const imported = uploaded
        .filter((asset) => FONT_EXT.test(asset))
        .map((asset) => ({
          family: fontFamilyFromAssetPath(asset),
          path: asset,
          url: `/api/projects/${encodeURIComponent(pid)}/preview/${asset}`,
        }));
      importedFontAssetsRef.current = [
        ...imported,
        ...importedFontAssetsRef.current.filter(
          (existing) =>
            !imported.some((font) => font.family.toLowerCase() === existing.family.toLowerCase()),
        ),
      ];
      return imported;
    },
    [uploadProjectFiles],
  );

  // ── Return ──

  return {
    // State
    editingFile,
    setEditingFile,
    projectDir,
    fileTree,
    fileTreeLoaded,

    // Refs
    editingPathRef,
    projectIdRef,
    importedFontAssetsRef,

    // Core I/O
    readProjectFile,
    writeProjectFile,
    overwriteExternalConflict,
    readOptionalProjectFile,
    observeProjectFileVersion,
    updateEditingFileContent,

    // Callbacks
    refreshFileTree,
    uploadProjectFiles,
    handleDeleteFile,
    handleDeleteComposition,
    handleRenameFile,
    handleImportFiles,
    handleImportFonts,

    // Derived
    compositions,
    assets,
    fontAssets,
  };
}
