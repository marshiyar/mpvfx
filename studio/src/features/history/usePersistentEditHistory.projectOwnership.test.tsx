// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { createMemoryEditHistoryStorage } from "./editHistoryStorage";
import { usePersistentEditHistory } from "./usePersistentEditHistory";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsyncEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("usePersistentEditHistory project ownership", () => {
  it("finishes an old project's durable save without publishing that stack into the new project", async () => {
    const memory = createMemoryEditHistoryStorage();
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const saving = new Promise<void>(resolve => { started = resolve; });
    const storage = { ...memory, set: async (projectId: string, state: Parameters<typeof memory.set>[1]) => {
      if (projectId === "a") { started(); await held; }
      await memory.set(projectId, state);
    } };
    const now = () => 100;
    const captured: { history: ReturnType<typeof usePersistentEditHistory> | null } = { history: null };
    function Probe({ projectId }: { projectId: string }) {
      captured.history = usePersistentEditHistory({ projectId, storage, now });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe projectId="a" />));
    await flushAsyncEffects();
    const pending = captured.history!.recordDurableEdit({ label: "A rename", kind: "manual", durableTransactionIds: ["a-receipt"], files: { "index.html": { before: "A", after: "A2" } } });
    await saving;
    await act(async () => root.render(<Probe projectId="b" />));
    await flushAsyncEffects();
    await act(async () => captured.history!.recordEdit({ label: "B edit", kind: "manual", files: { "index.html": { before: "B", after: "B2" } } }));
    await act(async () => { release(); await pending; });
    expect(captured.history!.undoLabel).toBe("B edit");
    expect(captured.history!.state.undo.map(entry => entry.projectId)).toEqual(["b"]);
    expect((await memory.get("a"))!.undo[0]!.label).toBe("A rename");
    expect((await memory.get("b"))!.undo[0]!.label).toBe("B edit");
    await act(async () => root.unmount());
  });

  it("rejects a delayed project A recorder after project B becomes active", async () => {
    const storage = createMemoryEditHistoryStorage();
    const now = () => 100;
    const captured: { history: ReturnType<typeof usePersistentEditHistory> | null } = {
      history: null,
    };

    function Probe({ projectId }: { projectId: string }) {
      captured.history = usePersistentEditHistory({ projectId, storage, now });
      return null;
    }

    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe projectId="project-a" />));
    await flushAsyncEffects();
    const recordProjectA = captured.history?.recordEdit;
    if (!recordProjectA) throw new Error("project A history did not load");

    await act(async () => root.render(<Probe projectId="project-b" />));
    await expect(
      recordProjectA({
        label: "Delayed A edit",
        kind: "manual",
        files: { "index.html": { before: "A", after: "A2" } },
      }),
    ).rejects.toThrow("inactive project project-a");
    await flushAsyncEffects();

    const recordProjectB = captured.history?.recordEdit;
    if (!recordProjectB) throw new Error("project B history did not load");
    await act(async () => {
      await recordProjectB({
        label: "B edit",
        kind: "manual",
        files: { "index.html": { before: "B", after: "B2" } },
      });
    });

    expect(await storage.get("project-a")).toBeNull();
    expect((await storage.get("project-b"))?.undo.map((entry) => entry.label)).toEqual(["B edit"]);

    await act(async () => root.unmount());
  });
});
