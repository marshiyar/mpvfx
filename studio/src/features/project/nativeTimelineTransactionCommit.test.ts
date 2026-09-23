import { describe, expect, it, vi } from "vitest";
import { commitNativeTimelineFileSnapshots } from "./nativeTimelineTransactionCommit";

const snapshots = {
  ".studio/project.json": { before: "native-before", after: "native-after" },
  "index.html": { before: "html-before", after: "html-after" },
};

describe("native timeline file transaction commit", () => {
  it("uses one durable server transaction instead of independent browser writes", async () => {
    const commitFileTransaction = vi.fn(async () => undefined);
    const writeProjectFile = vi.fn();
    const recordEdit = vi.fn();

    await commitNativeTimelineFileSnapshots({
      orderedPaths: [".studio/project.json", "index.html"],
      snapshots,
      history: {
        label: "Move timeline clip",
        kind: "timeline",
        coalesceKey: "timeline-move:clip-1",
      },
      commitFileTransaction,
      writeProjectFile,
      recordEdit,
      rollbackFailureMessage: "rollback failed",
    });

    expect(commitFileTransaction).toHaveBeenCalledWith({
      files: [
        {
          path: ".studio/project.json",
          expectedBefore: "native-before",
          after: "native-after",
        },
        { path: "index.html", expectedBefore: "html-before", after: "html-after" },
      ],
      history: {
        label: "Move timeline clip",
        kind: "timeline",
        coalesceKey: "timeline-move:clip-1",
      },
    });
    expect(writeProjectFile).not.toHaveBeenCalled();
    expect(recordEdit).not.toHaveBeenCalled();
  });

  it("publishes no browser history or compensating write after a durable server failure", async () => {
    const commitFailure = new Error("server crash recovery required");
    const writeProjectFile = vi.fn();
    const recordEdit = vi.fn();

    await expect(
      commitNativeTimelineFileSnapshots({
        orderedPaths: [".studio/project.json", "index.html"],
        snapshots,
        history: { label: "Move timeline clip", kind: "timeline" },
        commitFileTransaction: vi.fn(async () => {
          throw commitFailure;
        }),
        writeProjectFile,
        recordEdit,
        rollbackFailureMessage: "rollback failed",
      }),
    ).rejects.toBe(commitFailure);

    expect(writeProjectFile).not.toHaveBeenCalled();
    expect(recordEdit).not.toHaveBeenCalled();
  });

  it("preserves the existing CAS write, history, and reverse rollback fallback", async () => {
    const events: string[] = [];
    const writeProjectFile = vi.fn(async (path: string, content: string) => {
      events.push(`write:${path}:${content}`);
    });
    const recordEdit = vi.fn(async () => {
      events.push("history");
      throw new Error("history unavailable");
    });

    await expect(
      commitNativeTimelineFileSnapshots({
        orderedPaths: [".studio/project.json", "index.html"],
        snapshots,
        history: { label: "Move timeline clip", kind: "timeline" },
        writeProjectFile,
        recordEdit,
        rollbackFailureMessage: "rollback failed",
      }),
    ).rejects.toThrow("history unavailable");

    expect(events).toEqual([
      "write:.studio/project.json:native-after",
      "write:index.html:html-after",
      "history",
      "write:index.html:html-before",
      "write:.studio/project.json:native-before",
    ]);
    expect(writeProjectFile.mock.calls).toEqual([
      [".studio/project.json", "native-after", "native-before"],
      ["index.html", "html-after", "html-before"],
      ["index.html", "html-before", "html-after"],
      [".studio/project.json", "native-before", "native-after"],
    ]);
  });

  it("checks cancellation before delegating durability", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const commitFileTransaction = vi.fn();

    await expect(
      commitNativeTimelineFileSnapshots({
        orderedPaths: [".studio/project.json", "index.html"],
        snapshots,
        history: { label: "Move timeline clip", kind: "timeline" },
        commitFileTransaction,
        writeProjectFile: vi.fn(),
        recordEdit: vi.fn(),
        rollbackFailureMessage: "rollback failed",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(commitFileTransaction).not.toHaveBeenCalled();
  });
});
