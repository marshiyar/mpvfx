import { desktopRequest } from "./desktopClient";
import type { LocalMediaImportResult } from "../../shared/desktopBridge";

const MAX_SYNTHETIC_FILE_BYTES = 64 * 1024 * 1024;
const SAVE_TO_DISK = "Generated file exceeds 64 MiB; save it to disk and import it as a local file";

/** Keep disk-backed media native even when mixed with generated File objects. */
export async function importProjectFiles(projectId: string, files: File[], directory?: string): Promise<Response> {
  const upload = (batch: File[]) => {
    const body = new FormData();
    for (const file of batch) body.append("file", file);
    const query = directory ? `?dir=${encodeURIComponent(directory)}` : "";
    return desktopRequest(`/api/projects/${encodeURIComponent(projectId)}/upload${query}`, { method: "POST", body });
  };
  const importer = window.mpvfx?.importFiles;
  // The browser fallback retains its one-request batch for small selections.
  // Larger batches run one file at a time so no multipart IPC body crosses the
  // synthetic-file limit. Native disk-backed imports are checked separately.
  if (!importer && files.every(file => file.size <= MAX_SYNTHETIC_FILE_BYTES) &&
      files.reduce((total, file) => total + file.size, 0) <= MAX_SYNTHETIC_FILE_BYTES) return upload(files);
  const result: LocalMediaImportResult = { files: [], invalid: [] };
  for (const file of files) {
    try {
      const native = importer ? await importer(projectId, [file], directory) : null;
      if (native) {
        result.files.push(...native.files);
        result.invalid.push(...native.invalid);
        continue;
      }
      // Check before FormData and desktopRequest, which otherwise serialize the
      // entire File into an ArrayBuffer before the runtime can reject it.
      if (file.size > MAX_SYNTHETIC_FILE_BYTES) throw new Error(SAVE_TO_DISK);
      const response = await upload([file]);
      if (!response.ok) throw new Error(response.status === 413
        ? SAVE_TO_DISK
        : `Import failed (${response.status})`);
      const uploaded = await response.json();
      if (!Array.isArray(uploaded.files)) throw new Error("Invalid import response");
      result.files.push(...uploaded.files);
      result.invalid.push(...(uploaded.invalid ?? []));
      for (const name of uploaded.skipped ?? []) result.invalid.push({ name, reason: "Generated file exceeds the upload limit" });
    } catch (error) {
      result.invalid.push({ name: file.name, reason: error instanceof Error ? error.message : "Import failed" });
    }
  }
  return Response.json(result);
}
