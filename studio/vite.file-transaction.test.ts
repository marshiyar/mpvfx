// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDurableFileTransactionStore,
  type DurableFileTransactionInput,
} from "./vite.file-transaction";

const roots: string[] = [];

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "studio-file-transaction-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/index.html"), "before-html", "utf8");
  await writeFile(join(root, "project.json"), "before-project", "utf8");
  return root;
}

function transaction(id = "tx-1"): DurableFileTransactionInput {
  return {
    id,
    files: [
      { path: "src/index.html", expectedBefore: "before-html", after: "after-html" },
      { path: "project.json", expectedBefore: "before-project", after: "after-project" },
    ],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable file transactions", () => {
  it("validates every expected-before value before mutating any target", async () => {
    const root = await projectRoot();
    await writeFile(join(root, "project.json"), "external-change", "utf8");
    const store = createDurableFileTransactionStore({ projectRoot: root });

    await expect(store.commit(transaction())).rejects.toThrow(/project\.json.*changed/i);

    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("before-html");
    expect(await readFile(join(root, "project.json"), "utf8")).toBe("external-change");
    expect(await store.listReceipts()).toEqual([]);
  });

  it.each(["../outside", "/tmp/outside", ".hyperframes/recovery.json"])(
    "rejects unsafe transaction target %s without touching project files",
    async (path) => {
      const root = await projectRoot();
      const store = createDurableFileTransactionStore({ projectRoot: root });
      const input = transaction();
      input.files[0] = { ...input.files[0], path };

      await expect(store.commit(input)).rejects.toThrow(/unsafe|reserved|relative/i);
      expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("before-html");
      expect(await store.listReceipts()).toEqual([]);
    },
  );

  it("writes a PREPARED journal before the first target replacement", async () => {
    const root = await projectRoot();
    const afterPrepared = vi.fn(async (receipt) => {
      expect(receipt.state).toBe("PREPARED");
      expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("before-html");
      expect((await store.status("tx-1"))?.state).toBe("PREPARED");
    });
    const store = createDurableFileTransactionStore({ projectRoot: root, afterPrepared });

    await store.commit(transaction());

    expect(afterPrepared).toHaveBeenCalledOnce();
    expect((await store.status("tx-1"))?.state).toBe("COMMITTED");
    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("after-html");
    expect(await readFile(join(root, "project.json"), "utf8")).toBe("after-project");
  });

  it("recovers a partially applied PREPARED transaction to exact before bytes", async () => {
    const root = await projectRoot();
    const store = createDurableFileTransactionStore({
      projectRoot: root,
      afterTargetWrite: async (index) => {
        if (index === 0) throw new Error("simulated crash");
      },
    });
    await expect(store.commit(transaction())).rejects.toThrow("simulated crash");
    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("before-html");
    expect(await readFile(join(root, "project.json"), "utf8")).toBe("after-project");

    const recovery = await createDurableFileTransactionStore({ projectRoot: root }).recover();

    expect(recovery).toEqual([
      expect.objectContaining({ id: "tx-1", action: "rolled-back", state: "ROLLED_BACK" }),
    ]);
    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("before-html");
    expect(await readFile(join(root, "project.json"), "utf8")).toBe("before-project");
  });

  it("recovers a COMMITTED transaction to exact after bytes after later partial damage", async () => {
    const root = await projectRoot();
    const store = createDurableFileTransactionStore({ projectRoot: root });
    await store.commit(transaction());
    await writeFile(join(root, "src/index.html"), "damaged", "utf8");
    await rm(join(root, "project.json"));

    const recovery = await store.recover();

    expect(recovery).toEqual([
      expect.objectContaining({ id: "tx-1", action: "reapplied", state: "COMMITTED" }),
    ]);
    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("after-html");
    expect(await readFile(join(root, "project.json"), "utf8")).toBe("after-project");
  });

  it("supports exact creation and deletion during commit and recovery", async () => {
    const root = await projectRoot();
    await writeFile(join(root, "delete-me.txt"), "old", "utf8");
    const input: DurableFileTransactionInput = {
      id: "create-delete",
      files: [
        { path: "created.txt", expectedBefore: null, after: "new" },
        { path: "delete-me.txt", expectedBefore: "old", after: null },
      ],
    };
    const store = createDurableFileTransactionStore({ projectRoot: root });
    await store.commit(input);
    expect(await readFile(join(root, "created.txt"), "utf8")).toBe("new");
    await expect(readFile(join(root, "delete-me.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(join(root, "delete-me.txt"), "partial", "utf8");
    await rm(join(root, "created.txt"));
    await store.recover();
    expect(await readFile(join(root, "created.txt"), "utf8")).toBe("new");
    await expect(readFile(join(root, "delete-me.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("makes committed retries idempotent and rejects transaction-id payload reuse", async () => {
    const root = await projectRoot();
    const afterTargetWrite = vi.fn();
    const store = createDurableFileTransactionStore({ projectRoot: root, afterTargetWrite });

    const first = await store.commit(transaction());
    const retry = await store.commit(transaction());

    expect(retry).toEqual(first);
    expect(afterTargetWrite).toHaveBeenCalledTimes(2);
    const changed = transaction();
    changed.files[0].after = "different-after";
    await expect(store.commit(changed)).rejects.toThrow(/already belongs to a different payload/i);
  });

  it("resumes the same PREPARED transaction by rolling back before retrying", async () => {
    const root = await projectRoot();
    const crashing = createDurableFileTransactionStore({
      projectRoot: root,
      afterTargetWrite: async () => {
        throw new Error("crash");
      },
    });
    await expect(crashing.commit(transaction())).rejects.toThrow("crash");

    const retry = await createDurableFileTransactionStore({ projectRoot: root }).commit(transaction());

    expect(retry.state).toBe("COMMITTED");
    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("after-html");
    expect(await readFile(join(root, "project.json"), "utf8")).toBe("after-project");
  });

  it("lists unacknowledged receipts and only cleans terminal receipts on ACK", async () => {
    const root = await projectRoot();
    const store = createDurableFileTransactionStore({ projectRoot: root });
    await store.commit(transaction());

    expect(await store.listPending()).toEqual([]);
    expect(await store.listReceipts()).toEqual([
      expect.objectContaining({ id: "tx-1", state: "COMMITTED" }),
    ]);
    expect(await store.acknowledge("tx-1")).toBe(true);
    expect(await store.status("tx-1")).toBeNull();
    expect(await store.acknowledge("tx-1")).toBe(false);
  });

  it("refuses ACK for an unresolved PREPARED receipt", async () => {
    const root = await projectRoot();
    const crashing = createDurableFileTransactionStore({
      projectRoot: root,
      afterPrepared: async () => {
        throw new Error("crash");
      },
    });
    await expect(crashing.commit(transaction())).rejects.toThrow("crash");

    await expect(crashing.acknowledge("tx-1")).rejects.toThrow(/prepared/i);
    expect((await crashing.status("tx-1"))?.state).toBe("PREPARED");
    expect(await crashing.listPending()).toEqual([
      expect.objectContaining({ id: "tx-1", state: "PREPARED" }),
    ]);
  });

  it("reports corrupt journals deterministically and never mutates targets from them", async () => {
    const root = await projectRoot();
    const journalDir = join(root, ".hyperframes/studio-transactions");
    await mkdir(journalDir, { recursive: true });
    await writeFile(join(journalDir, "corrupt.json"), "{not-json", "utf8");
    const store = createDurableFileTransactionStore({ projectRoot: root });

    const first = await store.recover();
    const second = await store.recover();

    expect(first).toEqual(second);
    expect(first).toEqual([
      expect.objectContaining({ action: "corrupt", journal: "corrupt.json" }),
    ]);
    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("before-html");
    expect(await readFile(join(root, "project.json"), "utf8")).toBe("before-project");
  });

  it("detects a parseable but checksum-corrupted journal without trusting its paths", async () => {
    const root = await projectRoot();
    const store = createDurableFileTransactionStore({
      projectRoot: root,
      afterPrepared: async () => {
        throw new Error("crash");
      },
    });
    await expect(store.commit(transaction())).rejects.toThrow("crash");
    const receipt = await store.status("tx-1");
    expect(receipt?.journal).toMatch(/\.json$/);
    const journalPath = join(root, ".hyperframes/studio-transactions", receipt!.journal);
    const parsed = JSON.parse(await readFile(journalPath, "utf8"));
    parsed.files[0].path = "../outside";
    await writeFile(journalPath, JSON.stringify(parsed), "utf8");

    const result = await store.recover();

    expect(result).toEqual([
      expect.objectContaining({ action: "corrupt", journal: receipt!.journal }),
    ]);
    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("before-html");
  });

  it("rejects duplicate targets before creating a journal", async () => {
    const root = await projectRoot();
    const store = createDurableFileTransactionStore({ projectRoot: root });
    const input = transaction();
    input.files.push({ path: "src/index.html", expectedBefore: "before-html", after: "duplicate" });

    await expect(store.commit(input)).rejects.toThrow(/duplicate/i);
    expect(await store.listReceipts()).toEqual([]);
  });

  it("replays overlapping committed receipts in commit sequence rather than hashed filename order", async () => {
    const root = await projectRoot();
    const hash = (id: string) => createHash("sha256").update(id).digest("hex");
    const candidates = ["sequence-a", "sequence-b"].sort((left, right) =>
      hash(left).localeCompare(hash(right)),
    );
    const newerId = candidates[0];
    const olderId = candidates[1];
    const store = createDurableFileTransactionStore({ projectRoot: root });
    await store.commit({
      id: olderId,
      files: [{ path: "src/index.html", expectedBefore: "before-html", after: "middle" }],
    });
    await store.commit({
      id: newerId,
      files: [{ path: "src/index.html", expectedBefore: "middle", after: "final" }],
    });
    await writeFile(join(root, "src/index.html"), "damaged", "utf8");

    await createDurableFileTransactionStore({ projectRoot: root }).recover();

    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("final");
  });

  it("serializes commits across store instances for the same project", async () => {
    const root = await projectRoot();
    let releasePrepared!: () => void;
    const preparedGate = new Promise<void>((resolve) => {
      releasePrepared = resolve;
    });
    let announcePrepared!: () => void;
    const prepared = new Promise<void>((resolve) => {
      announcePrepared = resolve;
    });
    const firstStore = createDurableFileTransactionStore({
      projectRoot: root,
      afterPrepared: async () => {
        announcePrepared();
        await preparedGate;
      },
    });
    const secondStore = createDurableFileTransactionStore({ projectRoot: root });
    const first = firstStore.commit({
      id: "concurrent-first",
      files: [{ path: "src/index.html", expectedBefore: "before-html", after: "middle" }],
    });
    await prepared;
    const second = secondStore.commit({
      id: "concurrent-second",
      files: [{ path: "src/index.html", expectedBefore: "middle", after: "final" }],
    });
    releasePrepared();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: "COMMITTED" }),
      expect.objectContaining({ state: "COMMITTED" }),
    ]);
    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("final");
  });

  it("validates every recovery target before restoring any file", async () => {
    const root = await projectRoot();
    const outside = await mkdtemp(join(tmpdir(), "studio-file-transaction-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "index.html"), "outside", "utf8");
    const store = createDurableFileTransactionStore({
      projectRoot: root,
      afterPrepared: async () => {
        throw new Error("crash");
      },
    });
    await expect(store.commit(transaction())).rejects.toThrow("crash");
    await rm(join(root, "src"), { recursive: true });
    await symlink(outside, join(root, "src"));
    await writeFile(join(root, "project.json"), "external", "utf8");

    const result = await createDurableFileTransactionStore({ projectRoot: root }).recover();

    expect(result).toEqual([expect.objectContaining({ action: "corrupt", id: "tx-1" })]);
    expect(await readFile(join(root, "project.json"), "utf8")).toBe("external");
    expect(await readFile(join(outside, "index.html"), "utf8")).toBe("outside");
  });

  it("treats journal symlinks as corrupt instead of following them", async () => {
    const root = await projectRoot();
    const store = createDurableFileTransactionStore({ projectRoot: root });
    const receipt = await store.commit(transaction());
    const journalDir = join(root, ".hyperframes/studio-transactions");
    const validJournal = await readFile(join(journalDir, receipt.journal), "utf8");
    await rm(join(journalDir, receipt.journal));
    const outside = await mkdtemp(join(tmpdir(), "studio-journal-outside-"));
    roots.push(outside);
    const externalJournal = join(outside, "receipt.json");
    await writeFile(externalJournal, validJournal, "utf8");
    await symlink(externalJournal, join(journalDir, receipt.journal));

    expect(await store.listReceipts()).toEqual([
      expect.objectContaining({ state: "CORRUPT", journal: receipt.journal }),
    ]);
  });

  it("persists validated edit-history metadata through status and restart recovery", async () => {
    const root = await projectRoot();
    const history = {
      label: "Move timeline clips",
      kind: "timeline" as const,
      coalesceKey: "timeline-move:clip:a,clip:b",
      coalesceMs: 5_000,
    };
    const input = { ...transaction("history-tx"), history };
    const store = createDurableFileTransactionStore({ projectRoot: root });

    const committed = await store.commit(input);
    const restarted = createDurableFileTransactionStore({ projectRoot: root });
    const status = await restarted.status("history-tx");
    const recovery = await restarted.recover();

    expect(committed.history).toEqual(history);
    expect(status).toEqual(expect.objectContaining({ state: "COMMITTED", history }));
    expect(recovery).toEqual([
      expect.objectContaining({ id: "history-tx", action: "reapplied", history }),
    ]);
    expect(await restarted.listCommittedPendingHistory()).toEqual([
      expect.objectContaining({ id: "history-tx", state: "COMMITTED", history }),
    ]);
  });

  it.each([
    { label: "", kind: "timeline" },
    { label: "Move", kind: "agent" },
    { label: "Move", kind: "timeline", coalesceKey: "" },
    { label: "Move", kind: "timeline", coalesceMs: -1 },
    { label: "Move", kind: "timeline", coalesceMs: Number.NaN },
    { label: "Move", kind: "timeline", unexpected: true },
  ])("rejects malformed history metadata before journal creation: %o", async (history) => {
    const root = await projectRoot();
    const store = createDurableFileTransactionStore({ projectRoot: root });

    await expect(
      store.commit({ ...transaction("malformed-history"), history } as DurableFileTransactionInput),
    ).rejects.toThrow(/history/i);

    expect(await store.listReceipts()).toEqual([]);
    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("before-html");
  });

  it("includes history metadata in transaction-id idempotency", async () => {
    const root = await projectRoot();
    const store = createDurableFileTransactionStore({ projectRoot: root });
    const input = {
      ...transaction("history-idempotency"),
      history: { label: "Move clip", kind: "timeline" as const },
    };
    await store.commit(input);

    await expect(
      store.commit({
        ...input,
        history: { label: "Trim clip", kind: "timeline" },
      }),
    ).rejects.toThrow(/different payload/i);
  });

  it("lists only unacknowledged COMMITTED receipts as pending history", async () => {
    const root = await projectRoot();
    const store = createDurableFileTransactionStore({ projectRoot: root });
    await store.commit({
      ...transaction("committed-history"),
      history: { label: "Edit clip", kind: "manual" },
    });
    const preparedStore = createDurableFileTransactionStore({
      projectRoot: root,
      afterPrepared: async () => {
        throw new Error("crash");
      },
    });
    await expect(
      preparedStore.commit({
        id: "prepared-history",
        files: [{ path: "src/index.html", expectedBefore: "after-html", after: "later" }],
        history: { label: "Later edit", kind: "motion" },
      }),
    ).rejects.toThrow("crash");

    expect(await store.listCommittedPendingHistory()).toEqual([
      expect.objectContaining({ id: "committed-history", state: "COMMITTED" }),
    ]);
    await store.acknowledge("committed-history");
    expect(await store.listCommittedPendingHistory()).toEqual([]);
  });
});
