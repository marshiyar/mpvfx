// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitNativeTimelineFileTransaction } from "../project/nativeTimelineTransactionCommit";

const transactions = vi.hoisted(() => ({
  commit: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("../utils/studioFileTransaction", () => ({
  commitDurableStudioFileTransaction: transactions.commit,
  reconcileDurableStudioFileTransactions: transactions.reconcile,
}));

import { useDurableStudioFileTransactions } from "./useDurableStudioFileTransactions";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

beforeEach(() => {
  transactions.commit.mockReset().mockResolvedValue({ id: "tx", state: "COMMITTED" });
  transactions.reconcile.mockReset().mockResolvedValue({ reconciled: 0 });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function renderHarness(props: {
  projectId: string | null;
  historyLoaded: boolean;
  recordDurableEdit: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
  onCommit: (commit: CommitNativeTimelineFileTransaction) => void;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (next = props) =>
    act(() => {
      root.render(<Harness {...next} />);
    });
  render();
  return { rerender: render };
}

function Harness(props: {
  projectId: string | null;
  historyLoaded: boolean;
  recordDurableEdit: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
  onCommit: (commit: CommitNativeTimelineFileTransaction) => void;
}) {
  props.onCommit(useDurableStudioFileTransactions(props));
  return null;
}

describe("useDurableStudioFileTransactions", () => {
  it("waits for persistent history before reconciling committed server receipts", async () => {
    const props = {
      projectId: "demo",
      historyLoaded: false,
      recordDurableEdit: vi.fn(),
      showToast: vi.fn(),
      onCommit: vi.fn(),
    };
    const harness = renderHarness(props);
    await act(async () => {});
    expect(transactions.reconcile).not.toHaveBeenCalled();

    harness.rerender({ ...props, historyLoaded: true });
    await act(async () => {});

    expect(transactions.reconcile).toHaveBeenCalledWith({
      projectId: "demo",
      recordDurableEdit: props.recordDurableEdit,
    });
  });

  it("binds native transaction snapshots to the active project and durable history", async () => {
    let commit!: CommitNativeTimelineFileTransaction;
    const recordDurableEdit = vi.fn();
    renderHarness({
      projectId: "demo",
      historyLoaded: true,
      recordDurableEdit,
      showToast: vi.fn(),
      onCommit: (value) => (commit = value),
    });
    const input = {
      files: [{ path: "index.html", expectedBefore: "before", after: "after" }],
      history: { label: "Move timeline clip", kind: "timeline" as const },
    };

    await act(async () => commit(input));

    expect(transactions.commit).toHaveBeenCalledWith({
      projectId: "demo",
      files: input.files,
      history: input.history,
      recordDurableEdit,
    });
  });

  it("reports startup reconciliation failure without acknowledging it as success", async () => {
    transactions.reconcile.mockRejectedValueOnce(new Error("journal corrupt"));
    const showToast = vi.fn();
    renderHarness({
      projectId: "demo",
      historyLoaded: true,
      recordDurableEdit: vi.fn(),
      showToast,
      onCommit: vi.fn(),
    });

    await act(async () => {});

    expect(showToast).toHaveBeenCalledWith(
      "Saved edit recovery needs attention: journal corrupt",
      "error",
    );
  });

  it("rejects a commit after the project becomes inactive", async () => {
    let commit!: CommitNativeTimelineFileTransaction;
    const props = {
      projectId: "demo" as string | null,
      historyLoaded: true,
      recordDurableEdit: vi.fn(),
      showToast: vi.fn(),
      onCommit: (value: CommitNativeTimelineFileTransaction) => (commit = value),
    };
    const harness = renderHarness(props);
    harness.rerender({ ...props, projectId: null });

    await expect(
      commit({ files: [], history: { label: "Edit", kind: "timeline" } }),
    ).rejects.toThrow("without an active project");
  });
});
