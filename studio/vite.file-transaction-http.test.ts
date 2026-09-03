// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDurableFileTransactionStore } from "./vite.file-transaction";
import { createDurableFileTransactionHttpController } from "./vite.file-transaction-http";

const roots: string[] = [];

async function makeProject(name = "project"): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "studio-file-transaction-http-"));
  roots.push(parent);
  const root = join(parent, name);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/index.html"), "before", "utf8");
  await writeFile(join(root, "project.json"), "project-before", "utf8");
  return root;
}

function commitBody(id = "tx-1") {
  return Buffer.from(
    JSON.stringify({
      id,
      files: [
        { path: "src/index.html", expectedBefore: "before", after: "after" },
        { path: "project.json", expectedBefore: "project-before", after: "project-after" },
      ],
      history: {
        label: "Move timeline clip",
        kind: "timeline",
        coalesceKey: "timeline-move:clip-1",
        coalesceMs: 5_000,
      },
    }),
  );
}

function expectNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable file transaction HTTP controller", () => {
  it("commits a transaction for a safely decoded project id and returns its durable receipt", async () => {
    const root = await makeProject("Project One");
    const resolveProject = vi.fn(async (id: string) =>
      id === "Project One" ? { id, dir: root } : null,
    );
    const controller = createDurableFileTransactionHttpController({ resolveProject });

    const response = await controller.handle({
      method: "POST",
      pathname: "/projects/Project%20One/file-transactions/commit",
      body: commitBody(),
    });

    expect(response?.status).toBe(200);
    expectNoStore(response!);
    expect(await response!.json()).toEqual(
      expect.objectContaining({
        id: "tx-1",
        state: "COMMITTED",
        history: expect.objectContaining({ label: "Move timeline clip", kind: "timeline" }),
      }),
    );
    expect(resolveProject).toHaveBeenCalledWith("Project One");
    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("after");
    expect(await readFile(join(root, "project.json"), "utf8")).toBe("project-after");
  });

  it("recovers a committed journal before listing it for browser history reconciliation", async () => {
    const root = await makeProject();
    await createDurableFileTransactionStore({ projectRoot: root }).commit(
      JSON.parse(commitBody("reconcile-me").toString("utf8")),
    );
    await writeFile(join(root, "src/index.html"), "damaged-after-crash", "utf8");
    const controller = createDurableFileTransactionHttpController({
      resolveProject: async (id) => (id === "project" ? { id, dir: root } : null),
    });

    const response = await controller.handle({
      method: "GET",
      pathname: "/projects/project/file-transactions/pending-history",
    });

    expect(response?.status).toBe(200);
    expectNoStore(response!);
    expect(await response!.json()).toEqual({
      receipts: [expect.objectContaining({ id: "reconcile-me", state: "COMMITTED" })],
    });
    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("after");
  });

  it("exposes status, acknowledges only existing terminal receipts, and removes them from pending history", async () => {
    const root = await makeProject();
    const controller = createDurableFileTransactionHttpController({
      resolveProject: async () => ({ id: "project", dir: root }),
    });
    await controller.handle({
      method: "POST",
      pathname: "/projects/project/file-transactions/commit",
      body: commitBody("status-tx"),
    });

    const status = await controller.handle({
      method: "GET",
      pathname: "/projects/project/file-transactions/status-tx",
    });
    expect(status?.status).toBe(200);
    expect(await status!.json()).toEqual(expect.objectContaining({ id: "status-tx" }));

    const acknowledged = await controller.handle({
      method: "POST",
      pathname: "/projects/project/file-transactions/status-tx/acknowledge",
    });
    expect(acknowledged?.status).toBe(200);
    expect(await acknowledged!.json()).toEqual({ ok: true });

    const pending = await controller.handle({
      method: "GET",
      pathname: "/projects/project/file-transactions/pending-history",
    });
    expect(await pending!.json()).toEqual({ receipts: [] });

    const missingStatus = await controller.handle({
      method: "GET",
      pathname: "/projects/project/file-transactions/status-tx",
    });
    expect(missingStatus?.status).toBe(404);
    expectNoStore(missingStatus!);
    const missingAck = await controller.handle({
      method: "POST",
      pathname: "/projects/project/file-transactions/status-tx/acknowledge",
    });
    expect(missingAck?.status).toBe(404);
  });

  it("runs one shared recovery before any API access to the same real project", async () => {
    const root = await makeProject();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recover = vi.fn(async () => {
      await gate;
      return [];
    });
    const controller = createDurableFileTransactionHttpController({
      resolveProject: async (id) => ({ id, dir: id === "alias" ? join(root, ".") : root }),
      createStore: () => ({
        recover,
        commit: vi.fn(),
        status: vi.fn(),
        listReceipts: vi.fn(),
        listPending: vi.fn(),
        listCommittedPendingHistory: vi.fn(),
        acknowledge: vi.fn(),
      }),
    });

    const first = controller.ensureRecoveredForProjectPath("/projects/project/files/index.html");
    const second = controller.ensureRecoveredForProjectPath("/projects/alias/preview");
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    expect(recover).toHaveBeenCalledOnce();
    expect(await controller.ensureRecoveredForProjectPath("/projects/project/render")).toBeNull();
    expect(recover).toHaveBeenCalledOnce();
  });

  it("rolls back PREPARED work through the recovery seam before an unrelated project endpoint continues", async () => {
    const root = await makeProject();
    const crashing = createDurableFileTransactionStore({
      projectRoot: root,
      afterTargetWrite: async (index) => {
        if (index === 0) throw new Error("simulated process death");
      },
    });
    await expect(
      crashing.commit(JSON.parse(commitBody("prepared").toString("utf8"))),
    ).rejects.toThrow("simulated process death");
    expect(await readFile(join(root, "project.json"), "utf8")).toBe("project-after");
    const controller = createDurableFileTransactionHttpController({
      resolveProject: async () => ({ id: "project", dir: root }),
    });

    expect(
      await controller.ensureRecoveredForProjectPath("/projects/project/files/src%2Findex.html"),
    ).toBeNull();

    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("before");
    expect(await readFile(join(root, "project.json"), "utf8")).toBe("project-before");
  });

  it("rolls back a partially written commit before returning its same-process failure", async () => {
    const root = await makeProject();
    let failFirstCommit = true;
    const controller = createDurableFileTransactionHttpController({
      resolveProject: async () => ({ id: "project", dir: root }),
      createStore: (projectRoot) =>
        createDurableFileTransactionStore({
          projectRoot,
          afterTargetWrite: async (index) => {
            if (failFirstCommit && index === 0) {
              failFirstCommit = false;
              throw new Error("simulated target write failure");
            }
          },
        }),
    });

    const response = await controller.handle({
      method: "POST",
      pathname: "/projects/project/file-transactions/commit",
      body: commitBody("same-process-failure"),
    });

    expect(response?.status).toBe(500);
    expect(await readFile(join(root, "src/index.html"), "utf8")).toBe("before");
    expect(await readFile(join(root, "project.json"), "utf8")).toBe("project-before");
    expect(
      await controller.ensureRecoveredForProjectPath("/projects/project/files/src%2Findex.html"),
    ).toBeNull();
  });

  it.each([
    ["/projects/%2e%2e/file-transactions/pending-history", "unsafe project"],
    ["/projects/a%2Fb/file-transactions/pending-history", "encoded separator"],
    ["/projects/a%5Cb/file-transactions/pending-history", "encoded backslash"],
    ["/projects/%E0%A4%A/file-transactions/pending-history", "malformed encoding"],
  ])("rejects %s before project resolution (%s)", async (pathname) => {
    const resolveProject = vi.fn();
    const controller = createDurableFileTransactionHttpController({ resolveProject });

    const response = await controller.handle({ method: "GET", pathname });

    expect(response?.status).toBe(400);
    expectNoStore(response!);
    expect(resolveProject).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing project and null for routes it does not own", async () => {
    const controller = createDurableFileTransactionHttpController({
      resolveProject: async () => null,
    });

    expect(
      (
        await controller.handle({
          method: "GET",
          pathname: "/projects/missing/file-transactions/pending-history",
        })
      )?.status,
    ).toBe(404);
    expect(
      await controller.handle({ method: "GET", pathname: "/projects/project/files/index.html" }),
    ).toBeNull();
    expect(await controller.handle({ method: "GET", pathname: "/health" })).toBeNull();
  });

  it.each([
    undefined,
    Buffer.from(""),
    Buffer.from("{not-json"),
    Buffer.from("[]"),
    Buffer.from(JSON.stringify({ id: "tx", files: [] })),
    Buffer.from(
      JSON.stringify({
        id: "tx",
        files: [{ path: "../outside", expectedBefore: null, after: "bad" }],
      }),
    ),
  ])("returns 400 for a malformed commit body without leaking internals: %o", async (body) => {
    const root = await makeProject();
    const controller = createDurableFileTransactionHttpController({
      resolveProject: async () => ({ id: "project", dir: root }),
    });

    const response = await controller.handle({
      method: "POST",
      pathname: "/projects/project/file-transactions/commit",
      body,
    });

    expect(response?.status).toBe(400);
    expectNoStore(response!);
    expect(await response!.json()).toEqual({ error: expect.any(String) });
  });

  it("maps compare-and-swap and transaction-id reuse conflicts to 409", async () => {
    const root = await makeProject();
    const controller = createDurableFileTransactionHttpController({
      resolveProject: async () => ({ id: "project", dir: root }),
    });
    await writeFile(join(root, "src/index.html"), "external", "utf8");

    const stale = await controller.handle({
      method: "POST",
      pathname: "/projects/project/file-transactions/commit",
      body: commitBody("conflict"),
    });
    expect(stale?.status).toBe(409);
    expectNoStore(stale!);

    await writeFile(join(root, "src/index.html"), "before", "utf8");
    const first = await controller.handle({
      method: "POST",
      pathname: "/projects/project/file-transactions/commit",
      body: commitBody("same-id"),
    });
    expect(first?.status).toBe(200);
    const changed = JSON.parse(commitBody("same-id").toString("utf8"));
    changed.files[0].after = "different";
    const reused = await controller.handle({
      method: "POST",
      pathname: "/projects/project/file-transactions/commit",
      body: Buffer.from(JSON.stringify(changed)),
    });
    expect(reused?.status).toBe(409);
  });

  it("returns 500 and blocks project access when recovery finds a corrupt journal", async () => {
    const root = await makeProject();
    await mkdir(join(root, ".hyperframes/studio-transactions"), { recursive: true });
    await writeFile(join(root, ".hyperframes/studio-transactions/corrupt.json"), "{no", "utf8");
    const controller = createDurableFileTransactionHttpController({
      resolveProject: async () => ({ id: "project", dir: root }),
    });

    const failure = await controller.ensureRecoveredForProjectPath("/projects/project/preview");

    expect(failure?.status).toBe(500);
    expectNoStore(failure!);
    expect(await failure!.json()).toEqual({ error: expect.stringMatching(/recovery/i) });
    const pending = await controller.handle({
      method: "GET",
      pathname: "/projects/project/file-transactions/pending-history",
    });
    expect(pending?.status).toBe(500);
  });

  it("returns 405 with Allow for methods that target a controller-owned route", async () => {
    const root = await makeProject();
    const controller = createDurableFileTransactionHttpController({
      resolveProject: async () => ({ id: "project", dir: root }),
    });

    const response = await controller.handle({
      method: "DELETE",
      pathname: "/projects/project/file-transactions/commit",
    });

    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("POST");
    expectNoStore(response!);
  });
});
