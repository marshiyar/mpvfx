import { describe, expect, it } from "vitest";
import type { MutableRefObject } from "react";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { synchronizeIncomingNativeDocument } from "./nativeDocumentRefSync";

function project(revision: number, id = "project:p1"): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id,
    revision,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [],
    sequence: { id: "sequence:main", name: "Main", tracks: [] },
  });
}

describe("native document ref synchronization", () => {
  it("accepts a newly loaded lower revision from undo/redo as authoritative", () => {
    const original = project(0);
    const tracker = { current: original } as MutableRefObject<NativeProjectDocument | null>;
    const latest = { current: project(1) } as MutableRefObject<NativeProjectDocument | null>;
    const restored = project(0);

    synchronizeIncomingNativeDocument(tracker, latest, restored);

    expect(tracker.current).toBe(restored);
    expect(latest.current).toBe(restored);
  });

  it("does not replace a just-committed ref while React still supplies the same old object", () => {
    const oldProp = project(0);
    const committed = project(1);
    const tracker = { current: oldProp } as MutableRefObject<NativeProjectDocument | null>;
    const latest = { current: committed } as MutableRefObject<NativeProjectDocument | null>;

    synchronizeIncomingNativeDocument(tracker, latest, oldProp);

    expect(latest.current).toBe(committed);
  });

  it("accepts null and a newly loaded document for a different project", () => {
    const first = project(4);
    const tracker = { current: first } as MutableRefObject<NativeProjectDocument | null>;
    const latest = { current: first } as MutableRefObject<NativeProjectDocument | null>;

    synchronizeIncomingNativeDocument(tracker, latest, null);
    expect(latest.current).toBeNull();
    const second = project(0, "project:p2");
    synchronizeIncomingNativeDocument(tracker, latest, second);
    expect(latest.current).toBe(second);
  });
});
