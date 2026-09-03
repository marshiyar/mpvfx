import { describe, expect, it, vi } from "vitest";
import {
  DurableStudioHistoryPendingError,
  commitDurableStudioFileTransaction,
  reconcileDurableStudioFileTransactions,
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

  it("reconstructs a newly-created optional sidecar as empty bytes for Undo", async () => {
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
        files: { ".studio/project.json": { before: "", after: "after" } },
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
