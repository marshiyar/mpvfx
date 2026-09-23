import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableFileTransactionStore, type DurableFileTransactionReceipt, type DurableFileTransactionStoreOptions } from "../fileTransaction";
import { createDurableFileTransactionHttpController } from "../fileTransactionHttp";
import { mediaFileOperationResponse } from "../mediaFileOperations";

const roots: string[] = [];
const media = Buffer.from([0, 255, 192, 128, 1, 2, 3, 0, 12]);
const original = '<video id="media/a.mov" src="media/a.mov"></video>';

async function project(files: Record<string, string | Buffer> = {}, hooks: Partial<DurableFileTransactionStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "mpvfx-media-file-operations-"));
  roots.push(root);
  for (const [path, content] of Object.entries({ "media/a.mov": media, "index.html": original, ...files })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const resolveProject = async (id: string) => id === "demo" ? { id, dir: root } : null;
  const transactions = createDurableFileTransactionHttpController({
    resolveProject,
    createStore: projectRoot => createDurableFileTransactionStore({ projectRoot, ...hooks }),
  });
  return {
    root,
    transactions,
    request: (method: string, path: string, body?: Record<string, unknown>) => mediaFileOperationResponse({
      method,
      pathname: `/projects/demo/files/${encodeURIComponent(path)}`,
      body: body ? JSON.stringify(body) : undefined,
      resolveProject,
      transactions,
    }),
  };
}

async function exists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("durable media file operations", () => {
  it("renames binary media and exact owned references in one undoable transaction", async () => {
    const p = await project();
    const response = await p.request("PATCH", "media/a.mov", { newPath: "media/renamed.mov", transactionId: "rename-1" });
    expect(response?.status).toBe(200);
    const body = await response!.json() as { ok: boolean; path: string; receipt: DurableFileTransactionReceipt };
    expect(body).toMatchObject({ ok: true, path: "media/renamed.mov", receipt: { id: "rename-1", state: "COMMITTED", history: { kind: "manual" } } });
    expect(body.receipt.moves).toEqual([{ from: "media/a.mov", to: "media/renamed.mov", expectedVersion: createHash("sha256").update(media).digest("hex") }]);
    expect(await exists(join(p.root, "media/a.mov"))).toBe(false);
    expect(await readFile(join(p.root, "media/renamed.mov"))).toEqual(media);
    expect(await readFile(join(p.root, "index.html"), "utf8")).toBe('<video id="media/a.mov" src="media/renamed.mov"></video>');

    const undo = await p.transactions.handle({
      method: "POST", pathname: "/projects/demo/file-transactions/commit",
      body: JSON.stringify({
        id: "undo-rename-1",
        files: body.receipt.files.map(file => ({ path: file.path, expectedBefore: file.after, after: file.expectedBefore })),
        moves: body.receipt.moves?.map(move => ({ from: move.to, to: move.from, expectedVersion: move.expectedVersion })),
      }),
    });
    expect(undo?.status).toBe(200);
    expect(await readFile(join(p.root, "media/a.mov"))).toEqual(media);
    expect(await exists(join(p.root, "media/renamed.mov"))).toBe(false);
    expect(await readFile(join(p.root, "index.html"), "utf8")).toBe(original);
  });

  it("returns the committed receipt for a lost-response retry without touching files again", async () => {
    const p = await project();
    const input = { newPath: "media/b.mov", transactionId: "retry-rename" };
    const first = await p.request("PATCH", "media/a.mov", input);
    const retry = await p.request("PATCH", "media/a.mov", input);
    expect(first?.status).toBe(200);
    expect(retry?.status).toBe(200);
    expect(await retry!.json()).toEqual(await first!.json());
    expect((await p.request("PATCH", "media/a.mov", { ...input, newPath: "media/c.mov" }))?.status).toBe(409);
    expect(await readFile(join(p.root, "media/b.mov"))).toEqual(media);
  });

  it("blocks deletion while a composition still depends on the media", async () => {
    const p = await project();
    const response = await p.request("DELETE", "media/a.mov", { transactionId: "delete-1" });
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ dependents: ["index.html"] });
    expect(await readFile(join(p.root, "media/a.mov"))).toEqual(media);
    expect(await readFile(join(p.root, "index.html"), "utf8")).toBe(original);
  });

  it("archives unreferenced media intact and returns a reversible durable receipt", async () => {
    const p = await project({ "index.html": "<main></main>" });
    const response = await p.request("DELETE", "media/a.mov", { transactionId: "delete-unused" });
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body).toMatchObject({ ok: true, backupPath: ".hyperframes/deleted-media/delete-unused/a.mov", receipt: { files: [], state: "COMMITTED", history: { kind: "manual" } } });
    expect(await exists(join(p.root, "media/a.mov"))).toBe(false);
    expect(await readFile(join(p.root, body.backupPath))).toEqual(media);
    expect((await p.request("DELETE", "media/a.mov", { transactionId: "delete-unused" }))?.status).toBe(200);
  });

  it("deletes an unused native asset record and undo restores its exact identity and source bytes", async () => {
    const nativeSource = JSON.stringify({
      schemaVersion: 1, id: "project:demo", revision: 7,
      frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 1920, height: 1080, background: "#000000" },
      assets: [{ id: "asset:keep-this-id", kind: "video", name: "a.mov", source: "media/a.mov", durationFrames: 90 }],
      sequence: { id: "sequence:main", name: "Main", tracks: [] },
    });
    const p = await project({ "index.html": "<main></main>", ".studio/project.json": nativeSource });
    const response = await p.request("DELETE", "media/a.mov", { transactionId: "delete-native-unused" });
    expect(response?.status).toBe(200);
    const { receipt } = await response!.json() as { receipt: DurableFileTransactionReceipt };
    expect(JSON.parse(await readFile(join(p.root, ".studio/project.json"), "utf8"))).toMatchObject({ revision: 8, assets: [] });
    const undo = await p.transactions.handle({
      method: "POST", pathname: "/projects/demo/file-transactions/commit",
      body: JSON.stringify({ id: "undo-delete-native-unused",
        files: receipt.files.map(file => ({ path: file.path, expectedBefore: file.after, after: file.expectedBefore })),
        moves: receipt.moves?.map(move => ({ from: move.to, to: move.from, expectedVersion: move.expectedVersion })),
      }),
    });
    expect(undo?.status).toBe(200);
    expect(await readFile(join(p.root, ".studio/project.json"), "utf8")).toBe(nativeSource);
    expect(await readFile(join(p.root, "media/a.mov"))).toEqual(media);
  });

  it.each(["afterMoveLink", "afterMove", "afterTargetWrite"] as const)("rolls back bytes and references after a %s failure", async hook => {
    const p = await project({}, { [hook]: () => { throw new Error("Injected I/O failure"); } });
    const response = await p.request("PATCH", "media/a.mov", { newPath: "media/b.mov", transactionId: "failed-rename" });
    expect(response?.status).toBe(500);
    expect(await readFile(join(p.root, "media/a.mov"))).toEqual(media);
    expect(await exists(join(p.root, "media/b.mov"))).toBe(false);
    expect(await readFile(join(p.root, "index.html"), "utf8")).toBe(original);
    const status = await p.transactions.handle({ method: "GET", pathname: "/projects/demo/file-transactions/failed-rename" });
    expect(await status!.json()).toMatchObject({ state: "ROLLED_BACK" });
  });

  it("refuses to replace an existing destination or silently change its media format", async () => {
    const p = await project({ "media/b.mov": "other media bytes" });
    expect((await p.request("PATCH", "media/a.mov", { newPath: "media/b.mov" }))?.status).toBe(409);
    expect((await p.request("PATCH", "media/a.mov", { newPath: "media/a.mp4" }))?.status).toBe(400);
    expect(await readFile(join(p.root, "media/a.mov"))).toEqual(media);
    expect(await readFile(join(p.root, "media/b.mov"), "utf8")).toBe("other media bytes");
  });

  it("rejects script-bound media renames before moving any file", async () => {
    const p = await project({ "index.html": '<script>player.src="media/a.mov";</script>' });
    const response = await p.request("PATCH", "media/a.mov", { newPath: "media/b.mov" });
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ error: expect.stringContaining("executable script") });
    expect(await readFile(join(p.root, "media/a.mov"))).toEqual(media);
    expect(await exists(join(p.root, "media/b.mov"))).toBe(false);
  });

  it("protects CSS font dependencies and updates their exact URL when the font is renamed", async () => {
    const css = '@font-face { font-family: "fonts/title.woff2"; src: url("../fonts/title.woff2") format("woff2"); }';
    const p = await project({ "fonts/title.woff2": media, "styles/fonts.css": css });
    const deletion = await p.request("DELETE", "fonts/title.woff2");
    expect(deletion?.status).toBe(409);
    expect(await deletion!.json()).toMatchObject({ dependents: ["styles/fonts.css"] });
    const rename = await p.request("PATCH", "fonts/title.woff2", { newPath: "fonts/heading.woff2" });
    expect(rename?.status).toBe(200);
    expect(await readFile(join(p.root, "fonts/heading.woff2"))).toEqual(media);
    expect(await readFile(join(p.root, "styles/fonts.css"), "utf8")).toBe(css.replace('url("../fonts/title.woff2")', 'url("../fonts/heading.woff2")'));
  });

  it("protects color grading LUT dependencies and updates only their source field on rename", async () => {
    const grading = { preset: "cinema", lut: { src: "assets/luts/look.cube", intensity: 0.7 }, label: "assets/luts/look.cube" };
    const html = `<video src="media/a.mov" data-color-grading='${JSON.stringify(grading)}'></video>`;
    const p = await project({ "assets/luts/look.cube": "LUT_3D_SIZE 2\n", "index.html": html });
    const deletion = await p.request("DELETE", "assets/luts/look.cube");
    expect(deletion?.status).toBe(409);
    expect(await deletion!.json()).toMatchObject({ dependents: ["index.html"] });
    const rename = await p.request("PATCH", "assets/luts/look.cube", { newPath: "assets/luts/cinema.cube" });
    expect(rename?.status).toBe(200);
    expect(await readFile(join(p.root, "index.html"), "utf8")).toBe(`<video src="media/a.mov" data-color-grading='${JSON.stringify({ ...grading, lut: { ...grading.lut, src: "assets/luts/cinema.cube" } })}'></video>`);
  });

  it("blocks traversal, metadata operations, and directory operations that would bypass dependencies", async () => {
    const p = await project({ ".studio/hidden.mov": "hidden" });
    expect((await p.request("PATCH", "media/a.mov", { newPath: "../outside.mov" }))?.status).toBe(403);
    expect((await p.request("DELETE", ".studio/hidden.mov"))?.status).toBe(403);
    expect((await p.request("PATCH", "media", { newPath: "renamed" }))?.status).toBe(409);
    expect((await p.request("DELETE", "media"))?.status).toBe(409);
    expect(await readFile(join(p.root, "media/a.mov"))).toEqual(media);
  });

  it("rejects symlinked source, destination, and archive parents", async () => {
    const p = await project({ "index.html": "<main></main>" });
    const outside = await project();
    await symlink(join(outside.root, "media"), join(p.root, "linked"));
    expect((await p.request("PATCH", "media/a.mov", { newPath: "linked/b.mov" }))?.status).toBe(403);
    expect((await p.request("DELETE", "linked/a.mov"))?.status).toBe(403);
    await mkdir(join(p.root, ".hyperframes"), { recursive: true });
    await symlink(outside.root, join(p.root, ".hyperframes/deleted-media"));
    expect((await p.request("DELETE", "media/a.mov"))?.status).toBe(403);
    expect(await readFile(join(p.root, "media/a.mov"))).toEqual(media);
    expect(await readFile(join(outside.root, "media/a.mov"))).toEqual(media);
  });

  it("delegates unrelated methods and ordinary non-media files", async () => {
    const p = await project();
    expect(await p.request("GET", "media/a.mov")).toBeNull();
    expect(await p.request("PATCH", "index.html", { newPath: "scene.html" })).toBeNull();
    expect(await p.request("DELETE", "notes.md")).toBeNull();
  });
});
