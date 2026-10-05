import type { LibraryCommand, LibraryResult } from "./library/library";
/** The only messages the editor exchanges with Electron's main process. */
export const DESKTOP_ORIGIN = "mpvfx://editor";
export const DESKTOP_CHANNELS = {
  request: "mpvfx:request",
  library: "mpvfx:library",
  crosspost: "mpvfx:crosspost",
  importFiles: "mpvfx:import-files",
  cancel: "mpvfx:cancel",
  subscribe: "mpvfx:subscribe",
  unsubscribe: "mpvfx:unsubscribe",
  event: "mpvfx:event",
  prepareClose: "mpvfx:prepare-close",
  closePrepared: "mpvfx:close-prepared",
  cancelClose: "mpvfx:cancel-close",
} as const;

export interface DesktopRequest {
  id: string;
  path: string;
  method: string;
  headers: [string, string][];
  body?: ArrayBuffer;
}

export interface DesktopResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

export interface DesktopEvent { type: string; data: string }

/** A project-owned binary file relocation; content identity survives the move. */
export interface ProjectFileMove {
  from: string;
  to: string;
  expectedVersion: string;
}

/** Allows an interrupted undo/redo to finish updating its persistent history. */
export interface ProjectHistoryReplay {
  entryId: string;
  direction: "undo" | "redo";
}

export interface VideoFramesRequest {
  source: string;
  location?: "project" | "render";
  sourceStart?: number;
  sourceRangeDuration?: number;
  frameCount: number;
  width: number;
  height: number;
}

export interface VideoFramesResult {
  duration: number;
  aspect: number;
  width: number;
  height: number;
  /** JPEG frames encoded for the structured IPC response. */
  frames: string[];
}

export interface LocalMediaImportResult {
  files: string[];
  invalid: Array<{ name: string; reason: string }>;
}

export interface DesktopBridge {
  openCrosspost?(projectId: string, filename: string): Promise<void>;
  onPrepareClose?(flush: () => Promise<void>, cancel?: () => void): () => void;
  library?(command: LibraryCommand): Promise<LibraryResult>;
  /** null means a synthetic File has no filesystem path; use the bounded upload route. */
  importFiles?(projectId: string, files: Array<{ name: string; size: number; type: string }>, directory?: string): Promise<LocalMediaImportResult | null>;
  request(request: DesktopRequest): Promise<DesktopResponse>;
  cancel(id: string): void;
  subscribe(path: string, listener: (event: DesktopEvent) => void): () => void;
}
