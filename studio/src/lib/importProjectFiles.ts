import { desktopRequest } from "./desktopClient";
import type { LocalMediaImportResult } from "../../shared/desktopBridge";

/** Keep disk-backed media native even when mixed with generated File objects. */
export async function importProjectFiles(projectId: string, files: File[], directory?: string): Promise<Response> {
  const upload = (batch: File[]) => {
    const body = new FormData();
    for (const file of batch) body.append("file", file);
    const query = directory ? `?dir=${encodeURIComponent(directory)}` : "";
    return desktopRequest(`/api/projects/${encodeURIComponent(projectId)}/upload${query}`, { method: "POST", body });
  };
  const importer = window.mpvfx?.importFiles;
  if (!importer) return upload(files);
  const result: LocalMediaImportResult = { files: [], invalid: [] };
  for (const file of files) {
    try {
      const native = await importer(projectId, [file], directory);
      if (native) {
        result.files.push(...native.files);
        result.invalid.push(...native.invalid);
        continue;
      }
      const response = await upload([file]);
      if (!response.ok) throw new Error(response.status === 413
        ? "Generated file exceeds the upload limit; save it to disk and import it as a local file"
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
