import { desktopRequest } from "../../lib/desktopClient";
import { useState, useCallback, useMemo, useRef } from "react";
import type { EditingFile } from "../../lib/studioHelpers";
import { FONT_EXT } from "../media/mediaTypes";
import { partitionMediaImportFiles } from "../../../shared/media/mediaImportPolicy";
import { fontFamilyFromAssetPath, type ImportedFontAsset } from "../inspector/fontAssets";
import {
  createStudioSaveHttpError,
  retryStudioSave,
  StudioFileConflictError,
  StudioSaveNetworkError,
} from "./studioSaveDiagnostics";
import { createStudioWriteToken, markStudioWriteToken, studioExpectedFileVersion, studioFileContentVersion, studioWriteHeaders } from "./studioFileVersion";
import { useFileTree } from "./useFileTree";
import type { DurableRecordEditInput } from "./usePersistentEditHistory";
import { DurableStudioHistoryPendingError, finalizeDurableStudioFileTransaction, parseStudioDurableFileTransactionReceipt } from "./studioFileTransaction";
import { serializeStudioFileMutations } from "./studioFileMutationCoordinator";

interface UseFileManagerOptions {
  projectId: string | null;
  showToast: (message: string, tone?: "error" | "info") => void;
  setRefreshKey: React.Dispatch<React.SetStateAction<number>>;
  recordDurableEdit?: (input: DurableRecordEditInput) => Promise<void> | void;
}

// ── Hook ──

export function useFileManager({
  projectId,
  showToast,
  setRefreshKey,
  recordDurableEdit,
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
      const response = await desktopRequest(
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
        const preflight = await desktopRequest(
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
          response = await desktopRequest(
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
      const response = await desktopRequest(
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
        const res = await desktopRequest(`/api/projects/${encodeURIComponent(pid)}/upload${qs}`, {
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
          // Uploads receive unique asset paths and do not change the composition.
          // Reloading here races the caller's next edit (such as applying a LUT).
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
    [refreshFileTree, showToast],
  );

  // ── File CRUD ──

  const mutateProjectFile = useCallback(async (path: string, newPath?: string) => {
    const pid = projectId;
    if (!pid || projectIdRef.current !== pid) return;
    const transactionId = createStudioWriteToken();
    const paths = [...new Set([...fileTree.filter((file) => /\.(html|css|js|json)$/i.test(file)), ".studio/project.json"])];
    await serializeStudioFileMutations(writeProjectFile, paths, async () => {
      if (projectIdRef.current !== pid) return;
      const writeTokens = Object.fromEntries(paths.map((file) => {
        const token = createStudioWriteToken();
        markStudioWriteToken(token);
        return [file, token];
      }));
      let data: { receipt?: unknown; error?: string };
      try {
        const response = await desktopRequest(`/api/projects/${encodeURIComponent(pid)}/files/${encodeURIComponent(path)}`, {
          method: newPath === undefined ? "DELETE" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactionId, newPath, writeTokens }),
        });
        if (!response.ok) throw await createStudioSaveHttpError(response, `File operation failed for ${path}`);
        data = await response.json();
      } catch (error) {
        // The bytes may already be committed if only the IPC response was lost.
        const status = await desktopRequest(`/api/projects/${encodeURIComponent(pid)}/file-transactions/${encodeURIComponent(transactionId)}`).catch(() => null);
        if (!status?.ok) throw error;
        const receipt = await status.json();
        if (receipt.state !== "COMMITTED") throw error;
        data = { receipt };
      }
      // A committed receipt stays in its project's journal until that project
      // can record it. Never finalize it through a newly opened editor session.
      if (projectIdRef.current !== pid) return;
      if (data.receipt) {
        const receipt = parseStudioDurableFileTransactionReceipt(data.receipt);
        if (receipt.id !== transactionId) throw new Error("File operation returned a different transaction receipt");
        for (const file of receipt.files) {
          fileVersions.set(file.path, file.after === null ? null : await studioFileContentVersion(file.after));
        }
        if (projectIdRef.current !== pid) return;
        try {
          await finalizeDurableStudioFileTransaction({ projectId: pid, receipt, recordDurableEdit: recordDurableEdit ?? (() => { throw new Error("Undo history is unavailable"); }) });
        } catch (error) {
          if (!(error instanceof DurableStudioHistoryPendingError)) throw error;
          if (projectIdRef.current === pid) showToast("File change saved. Undo history is retained for recovery when the project reopens.", "error");
        }
      }
      if (projectIdRef.current !== pid) return;
      fileVersions.delete(path);
      if (editingPathRef.current === path) {
        setEditingFile((current) => newPath && current ? { ...current, path: newPath } : null);
      }
      await refreshFileTree();
      if (projectIdRef.current !== pid) return;
      setRefreshKey((key) => key + 1);
    });
  }, [fileTree, fileVersions, projectId, recordDurableEdit, refreshFileTree, setRefreshKey, showToast, writeProjectFile]);

  const handleDeleteFile = useCallback(
    async (path: string) => {
      try { await mutateProjectFile(path); }
      catch (error) {
        showToast(`Couldn't delete ${path}: ${error instanceof Error ? error.message : "operation failed"}`, "error");
      }
    },
    [mutateProjectFile, showToast],
  );

  const handleDeleteComposition = useCallback(
    async (path: string): Promise<boolean> => {
      const pid = projectIdRef.current;
      if (!pid) return false;
      try {
        const readResponse = await desktopRequest(
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

        const response = await desktopRequest(
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
      try { await mutateProjectFile(oldPath, newPath); }
      catch (error) {
        showToast(`Couldn't rename ${oldPath}: ${error instanceof Error ? error.message : "operation failed"}`, "error");
      }
    },
    [mutateProjectFile, showToast],
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
