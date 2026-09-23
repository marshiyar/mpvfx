import { describe, expect, it, vi } from "vitest";
import {
  DurableStudioHistoryPendingError,
  commitDurableStudioFileTransaction,
  reconcileDurableStudioFileTransactions,
  finalizeDurableStudioFileTransaction,
  applyDurableStudioHistoryTransaction,
  parseStudioDurableFileTransactionReceipt,
  type StudioDurableFileTransactionReceipt,
} from "./studioFileTransaction";
import { consumeStudioWriteToken, resetStudioWriteTokens } from "./studioFileVersion";

const receipt = (
  overrides: Partial<StudioDurableFileTransactionReceipt> = {},
): StudioDurableFileTransactionReceipt => ({
  id: "tx-1",
  state: "COMMITTED",
  sequence: 1,
  files: [
    {
      path: "index.html",
      expectedBefore: "before html",
      after: "after html",
    },
    {
      path: ".studio/project.json",
      expectedBefore: "before project",
      after: "after project",
    },
  ],
  history: {
    label: "Move clip",
    kind: "timeline",
    coalesceKey: "clip:move",
    coalesceMs: 250,
  },
  ...overrides,
});

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("durable Studio file transaction client", () => {
  it.each(["lost response", "server error"])("recovers a committed receipt after %s without resubmitting the edit", async (failure) => {
    const fetchImpl = vi.fn();
    if (failure === "lost response") fetchImpl.mockRejectedValueOnce(new Error("IPC response lost"));
    else fetchImpl.mockResolvedValueOnce(jsonResponse({ error: "Response failed" }, 500));
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(receipt()))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const recordDurableEdit = vi.fn();
    await expect(commitDurableStudioFileTransaction({
      projectId: "demo", transactionId: "tx-1", files: receipt().files,
      history: receipt().history!, fetchImpl, recordDurableEdit,
    })).resolves.toEqual(receipt());
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/projects/demo/file-transactions/commit",
      "/api/projects/demo/file-transactions/tx-1",
      "/api/projects/demo/file-transactions/tx-1/acknowledge",
    ]);
    expect(recordDurableEdit).toHaveBeenCalledOnce();
  });

  it("preserves conflict status so save queues stop stale work", async () => {
    await expect(commitDurableStudioFileTransaction({
      projectId: "demo", transactionId: "tx-1", files: receipt().files,
      history: receipt().history!,
      fetchImpl: async () => jsonResponse({ error: "Conflict" }, 409),
      recordDurableEdit: vi.fn(),
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("commits files, durably records Undo, and only then acknowledges the receipt", async () => {
    const events: string[] = [];
    const committed = receipt();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      events.push(String(url).endsWith("/acknowledge") ? "ack" : "commit");
      if (String(url).endsWith("/acknowledge")) return jsonResponse({ ok: true });
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        id: "tx-1",
        files: committed.files,
        history: committed.history,
        writeTokens: expect.objectContaining({
          "index.html": expect.any(String),
          ".studio/project.json": expect.any(String),
        }),
      });
      return jsonResponse(committed);
    });
    const recordDurableEdit = vi.fn(async () => {
      events.push("history");
    });

    const result = await commitDurableStudioFileTransaction({
      projectId: "demo project",
      transactionId: "tx-1",
      files: committed.files,
      history: committed.history!,
      fetchImpl,
      recordDurableEdit,
    });

    expect(result).toEqual(committed);
    expect(events).toEqual(["commit", "history", "ack"]);
    expect(recordDurableEdit).toHaveBeenCalledWith({
      label: "Move clip",
      kind: "timeline",
      coalesceKey: "clip:move",
      coalesceMs: 250,
      durableTransactionIds: ["tx-1"],
      files: {
        "index.html": { before: "before html", after: "after html" },
        ".studio/project.json": { before: "before project", after: "after project" },
      },
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "/api/projects/demo%20project/file-transactions/commit",
    );
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "/api/projects/demo%20project/file-transactions/tx-1/acknowledge",
    );
    const committedBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const tokens = Object.values(committedBody.writeTokens) as string[];
    expect(new Set(tokens).size).toBe(2);
    expect(tokens.every((token) => consumeStudioWriteToken(token))).toBe(true);
    resetStudioWriteTokens();
  });

  it("leaves a committed receipt unacknowledged when durable history persistence fails", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(receipt()));
    const historyFailure = new Error("IndexedDB quota exceeded");

    await expect(
      commitDurableStudioFileTransaction({
        projectId: "demo",
        transactionId: "tx-1",
        files: receipt().files,
        history: receipt().history!,
        fetchImpl,
        recordDurableEdit: vi.fn(async () => {
          throw historyFailure;
        }),
      }),
    ).rejects.toMatchObject({
      name: "DurableStudioHistoryPendingError",
      transactionId: "tx-1",
      cause: historyFailure,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not record history when the server rejects a stale transaction", async () => {
    const recordDurableEdit = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "Transaction target index.html changed before commit" }, 409),
    );

    await expect(
      commitDurableStudioFileTransaction({
        projectId: "demo",
        transactionId: "tx-1",
        files: receipt().files,
        history: receipt().history!,
        fetchImpl,
        recordDurableEdit,
      }),
    ).rejects.toThrow("changed before commit");

    expect(recordDurableEdit).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("generates one stable transaction id when the caller does not provide one", async () => {
    const committed = receipt({ id: "generated-42" });
    const createTransactionId = vi.fn(() => "generated-42");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(committed))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await commitDurableStudioFileTransaction({
      projectId: "demo",
      files: committed.files,
      history: committed.history!,
      fetchImpl,
      createTransactionId,
      recordDurableEdit: vi.fn(),
    });

    expect(createTransactionId).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).id).toBe("generated-42");
    resetStudioWriteTokens();
  });

  it("reconstructs pending durable history in sequence and acknowledges each only after success", async () => {
    const first = receipt({ id: "tx-1", sequence: 1 });
    const second = receipt({
      id: "tx-2",
      sequence: 2,
      history: { label: "Trim clip", kind: "timeline" },
      files: [
        { path: "index.html", expectedBefore: "after html", after: "trimmed html" },
      ],
    });
    const events: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.endsWith("/pending-history")) {
        events.push("list");
        return jsonResponse({ receipts: [second, first] });
      }
      const id = path.includes("tx-1") ? "tx-1" : "tx-2";
      events.push(`ack:${id}`);
      return jsonResponse({ ok: true });
    });
    const recordDurableEdit = vi.fn(async (input: { durableTransactionIds: readonly string[] }) => {
      events.push(`history:${input.durableTransactionIds[0]}`);
    });

    const result = await reconcileDurableStudioFileTransactions({
      projectId: "demo",
      fetchImpl,
      recordDurableEdit,
    });

    expect(result).toEqual({ reconciled: 2 });
    expect(events).toEqual([
      "list",
      "history:tx-1",
      "ack:tx-1",
      "history:tx-2",
      "ack:tx-2",
    ]);
  });

  it("stops reconciliation without acknowledging the failed or later receipt", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/pending-history")) {
        return jsonResponse({ receipts: [receipt(), receipt({ id: "tx-2", sequence: 2 })] });
      }
      return jsonResponse({ ok: true });
    });
    const recordDurableEdit = vi.fn(async () => {
      throw new Error("history unavailable");
    });

    await expect(
      reconcileDurableStudioFileTransactions({ projectId: "demo", fetchImpl, recordDurableEdit }),
    ).rejects.toBeInstanceOf(DurableStudioHistoryPendingError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(recordDurableEdit).toHaveBeenCalledTimes(1);
  });

  it("preserves absence separately from empty bytes for optional-file Undo", async () => {
    const created = receipt({
      files: [{ path: ".studio/project.json", expectedBefore: null, after: "after" }],
    });
    const recordDurableEdit = vi.fn();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/pending-history")) {
        return jsonResponse({ receipts: [created] });
      }
      return jsonResponse({ ok: true });
    });

    await reconcileDurableStudioFileTransactions({
      projectId: "demo",
      fetchImpl,
      recordDurableEdit,
    });

    expect(recordDurableEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        files: { ".studio/project.json": { before: "", after: "after", beforeExists: false } },
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("finalizes a move-only delete receipt without submitting the mutation again", async () => {
    const committed = receipt({ files: [], moves: [{ from: "media/a.mov", to: ".studio/trash/a.mov", expectedVersion: "a".repeat(64) }], history: { label: "Delete a.mov", kind: "manual" } });
    const recordDurableEdit = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    await finalizeDurableStudioFileTransaction({ projectId: "demo", receipt: committed, recordDurableEdit, fetchImpl });
    expect(recordDurableEdit).toHaveBeenCalledWith({ label: "Delete a.mov", kind: "manual", files: {}, moves: committed.moves, durableTransactionIds: ["tx-1"] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/projects/demo/file-transactions/tx-1/acknowledge");
  });

  it.each([
    [],
    [{ from: "a", to: "a", expectedVersion: "a".repeat(64) }],
    [{ from: "a", to: "b", expectedVersion: "not-a-version" }],
    [{ from: "a", to: "b", expectedVersion: "a".repeat(64) }, { from: "b", to: "c", expectedVersion: "a".repeat(64) }],
  ])("rejects an empty or ambiguous move-only receipt", moves => {
    expect(() => parseStudioDurableFileTransactionReceipt(receipt({ files: [], moves }))).toThrow();
  });

  it("applies an atomic history replay and waits for its caller to acknowledge durable history", async () => {
    const committed = receipt({ history: undefined, historyReplay: { entryId: "edit-1", direction: "undo" }, moves: [{ from: "media/b.mov", to: "media/a.mov", expectedVersion: "a".repeat(64) }] });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/acknowledge") ? jsonResponse({ ok: true }) : jsonResponse(committed));
    const applied = await applyDurableStudioHistoryTransaction({
      projectId: "demo", transactionId: "tx-1", files: committed.files, moves: committed.moves, historyReplay: committed.historyReplay!, fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ historyReplay: committed.historyReplay, moves: committed.moves });
    await applied.acknowledge();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reconciles a replay receipt as a stack transition rather than a new edit", async () => {
    const committed = receipt({ history: undefined, historyReplay: { entryId: "edit-1", direction: "undo" } });
    const recordDurableEdit = vi.fn();
    await reconcileDurableStudioFileTransactions({ projectId: "demo", recordDurableEdit, fetchImpl: async url => String(url).endsWith("/pending-history") ? jsonResponse({ receipts: [committed] }) : jsonResponse({ ok: true }) });
    expect(recordDurableEdit).toHaveBeenCalledWith(expect.objectContaining({ files: {}, historyReplay: committed.historyReplay, durableTransactionIds: ["tx-1"] }));
  });
});
