// ---------------------------------------------------------------------------
// Roughly what shape the current project has for actionable crash reports.
//
// A crash report says what broke. It does not say what the user was working ON,
// and a project with 14 compositions and 60 assets reproduces a crash that
// "Cannot read properties of undefined" never will.
//
// Held at module scope on purpose: a crash unmounts the React tree, so anything
// living in component state is gone by the time the crash prompt renders. This
// survives, because it was captured when the project loaded.
//
// PRIVACY: counts only. No file names, paths, project title, or authoring
// metadata.
// ---------------------------------------------------------------------------

import type { FeedbackContext } from "./feedbackTrigger";
import { isImportableMediaPath } from "../../utils/mediaImportPolicy";

let snapshot: FeedbackContext = {};

function countMedia(files: string[]): number {
  return files.filter(isImportableMediaPath).length;
}

/**
 * Record only aggregate counts from the project listing already loaded by the
 * editor. This performs no extra file reads.
 */
export function captureProjectProvenance(
  _projectId: string,
  files: string[],
  compositions: string[],
): void {
  snapshot = {
    project_composition_count: compositions.length,
    project_file_count: files.length,
    project_media_count: countMedia(files),
  };
}

export function projectProvenance(): FeedbackContext {
  return snapshot;
}

/** Test seam. */
export function resetProjectProvenance(): void {
  snapshot = {};
}
