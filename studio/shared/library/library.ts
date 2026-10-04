/** Versioned native library bridge. Filesystem locators stay in the host. */
export interface LibraryEvent {
  id: string;
  name: string;
}
export interface LibraryProject {
  id: string;
  eventId: string;
  name: string;
  state: "pending" | "ready";
}
export interface LibraryAsset {
  id: string;
  eventId: string;
  name: string;
  kind: string;
  mode: "managed" | "linked";
  state: "pending" | "ready";
  available?: boolean;
}
export interface LibraryJob {
  id: string;
  projectId: string;
  status: string;
  output: string;
  error: string;
}
export interface LibraryView {
  id: string;
  name: string;
  path: string;
  events: LibraryEvent[];
  projects: LibraryProject[];
  assets: LibraryAsset[];
  jobs: LibraryJob[];
}
export type LibraryCommand =
  | { type: "list" }
  | { type: "create" }
  | { type: "open" }
  | { type: "event"; libraryId: string; name: string }
  | { type: "project"; libraryId: string; eventId: string; name: string }
  | {
      type: "import";
      libraryId: string;
      eventId: string;
      mode: "managed" | "linked";
      projectId?: string;
    }
  | { type: "attach"; libraryId: string; projectId: string; assetId: string }
  | { type: "reveal"; libraryId: string }
  | { type: "relink"; libraryId: string; assetId: string }
  | { type: "saveOutput"; libraryId: string; jobId: string };
export interface LibraryResult {
  libraries: LibraryView[];
  projectId?: string;
  path?: string;
  errors?: string[];
}
