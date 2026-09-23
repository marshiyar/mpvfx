import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStudioRuntime, type StudioRuntime } from "../service";
import type { StudioServerAdapter } from "../adapter";
import * as adapterModule from "../adapter";

const { watchers } = vi.hoisted(() => ({ watchers: [] as EventEmitter[] }));
vi.mock("chokidar", () => ({
  watch: () => {
    const watcher = Object.assign(new EventEmitter(), {
      close: async () => {}, add: () => {},
    });
    watchers.push(watcher);
    queueMicrotask(() => watcher.emit("ready"));
    return watcher;
  },
}));

const roots: string[] = [];
const runtimes: StudioRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  watchers.length = 0;
  vi.restoreAllMocks();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function setup(fetch: (request: Request) => Promise<Response>) {
  const projectsDir = await mkdtemp(join(tmpdir(), "save-coordination-"));
  roots.push(projectsDir);
  await mkdir(join(projectsDir, "other"));
  const onFileChange = vi.fn();
  const consumeFileWriteReceipt = vi.fn((path: string) => ({ path, writeToken: "own-write" }));
  let adapter: StudioServerAdapter | null = null;
  const runtime = createStudioRuntime({
    projectsDir,
    onFileChange,
    adapterHost: {
      studioDir: projectsDir,
      loadModule: async <T,>() => ({
        createStudioApi: (value: StudioServerAdapter) => { adapter = value; return { fetch }; },
        fileContentVersion: (content: string) => content,
        consumeFileWriteReceipt,
      }) as T,
    },
  });
  runtimes.push(runtime);
  await symlink(join(projectsDir, "MpVFX"), join(projectsDir, "alias"));
  const request = (path: string, method = "GET", signal?: AbortSignal) => runtime.handle(
    new Request(`mpvfx://editor/api/projects/${path}`, { method, signal }),
  );
  return {
    request, projectsDir, onFileChange, runtime, consumeFileWriteReceipt,
    getAdapter: () => { if (!adapter) throw new Error("API has not loaded"); return adapter; },
  };
}

describe("main-process save coordination", () => {
  it("publishes binary replacement and deletion revisions without consuming a text save receipt", async () => {
    const { request, projectsDir, onFileChange, consumeFileWriteReceipt } = await setup(async () => new Response("ok"));
    await request("MpVFX/files/index.html");
    const source = join(projectsDir, "MpVFX/clip.MOV");
    await writeFile(source, Buffer.from([0, 255, 128, 42]));
    watchers[0].emit("add", source);
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledOnce());
    const first = onFileChange.mock.calls[0][0];
    expect(first).toEqual({ projectId: "MpVFX", path: "clip.MOV", kind: "media", version: expect.any(String) });
    expect(consumeFileWriteReceipt).not.toHaveBeenCalled();
    await writeFile(source, Buffer.from([128, 0, 9, 8, 7]));
    watchers[0].emit("change", source);
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledTimes(2));
    expect(onFileChange.mock.calls[1][0].version).not.toBe(first.version);
    await rm(source);
    watchers[0].emit("unlink", source);
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledTimes(3));
    expect(onFileChange.mock.calls[2][0]).toEqual({ projectId: "MpVFX", path: "clip.MOV", kind: "media", version: null });
    expect(consumeFileWriteReceipt).not.toHaveBeenCalled();
  });

  it("does not publish archived media as a live project source", async () => {
    const { request, projectsDir, onFileChange } = await setup(async () => new Response("ok"));
    await request("MpVFX/files/index.html");
    const archive = join(projectsDir, "MpVFX/.studio/media-trash/deleted");
    await mkdir(archive, { recursive: true });
    const archived = join(archive, "clip.mp4");
    await writeFile(archived, "archived media");
    watchers[0].emit("add", archived);
    const live = join(projectsDir, "MpVFX/clip.mp4");
    await writeFile(live, "live media");
    watchers[0].emit("add", live);
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledOnce());
    expect(onFileChange.mock.calls[0][0]).toMatchObject({ path: "clip.mp4", kind: "media" });
  });

  it.each(["preview/assets/clip.mp4", "preview/comp/scene.html", "waveform/assets/clip.mp4"])(
    "prevents transport caches retaining %s across same-path replacement",
    async (path) => {
      const { request } = await setup(async () => new Response("bytes", { headers: { "cache-control": "public, max-age=3600" } }));
      const response = await request(`MpVFX/${path}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("bytes");
    },
  );

  it.each([200, 500])("invalidates a mutation's cached signature before its %i response resolves, without a watcher event", async (status) => {
    let source = "";
    const { request, projectsDir, getAdapter } = await setup(async (request) => {
      if (request.method === "PUT") {
        await writeFile(source, `changed bytes after mutation returning ${status}`);
        return new Response("written", { status });
      }
      return new Response("ok");
    });
    await request("MpVFX/files/index.html");
    source = join(projectsDir, "MpVFX/index.html");
    const adapter = getAdapter();
    const project = await adapter.resolveProject("MpVFX");
    if (!project) throw new Error("Project not found");
    const before = adapter.getProjectSignature(project.dir);
    expect(adapter.getProjectSignature(project.dir)).toBe(before);
    expect((await request("MpVFX/files/index.html", "PUT")).status).toBe(status);
    expect(adapter.getProjectSignature(project.dir)).not.toBe(before);
  });

  it.each(["file-mutations/probe-element/index.html", "media/frames"])(
    "keeps the source signature cached across the read-only POST %s",
    async (path) => {
      const makeCache = adapterModule.createProjectSignatureCache;
      let count = 0;
      vi.spyOn(adapterModule, "createProjectSignatureCache").mockImplementation(options =>
        makeCache({ ...options, compute: () => `signature-${++count}` }));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { request, getAdapter } = await setup(async () => new Response("ok"));
      await request("MpVFX/files/index.html");
      const adapter = getAdapter();
      const project = await adapter.resolveProject("MpVFX");
      if (!project) throw new Error("Project not found");
      expect(adapter.getProjectSignature(project.dir)).toBe("signature-1");
      const response = await request(`MpVFX/${path}`, "POST");
      // The missing thumbnail payload is rejected before native decoding; even
      // a failed media read must not invalidate the project's source signature.
      expect(response.status).toBe(path === "media/frames" ? 500 : 200);
      expect(adapter.getProjectSignature(project.dir)).toBe("signature-1");
      expect(count).toBe(1);
    },
  );

  it("publishes a linked project's real-path media change under its project identity", async () => {
    const external = await mkdtemp(join(tmpdir(), "linked-media-project-"));
    roots.push(external);
    const { request, projectsDir, onFileChange } = await setup(async () => new Response("ok"));
    await symlink(external, join(projectsDir, "linked"));
    await request("linked/files/index.html");
    const source = join(external, "clip.mp4");
    await writeFile(source, "linked media");
    watchers[0].emit("change", source);
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "linked", path: "clip.mp4", kind: "media", version: expect.any(String),
    })));
  });

  it("publishes one revision to every opened project alias without repeating unchanged media events", async () => {
    const { request, projectsDir, onFileChange } = await setup(async () => new Response("ok"));
    await request("MpVFX/files/index.html");
    await request("alias/files/index.html");
    const source = join(projectsDir, "MpVFX/clip.mp4");
    await writeFile(source, "same physical media");
    watchers[0].emit("change", source);
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledTimes(2));
    const events = onFileChange.mock.calls.map(([event]) => event);
    expect(events.map(event => event.projectId).sort()).toEqual(["MpVFX", "alias"]);
    expect(events.every(event => event.path === "clip.mp4" && event.kind === "media")).toBe(true);
    expect(new Set(events.map(event => event.version)).size).toBe(1);
    watchers[0].emit("change", source);
    await request("alias/files/index.html");
    expect(onFileChange).toHaveBeenCalledTimes(2);
  });

  it("holds reads, alias writes, and watcher receipts behind an in-flight save, without blocking other projects", async () => {
    const started = gate();
    const finish = gate();
    const calls: string[] = [];
    const { request, projectsDir, onFileChange } = await setup(async (request) => {
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (request.method === "PUT") {
        started.release();
        await finish.promise;
      }
      return Response.json({ ok: true });
    });
    const write = request("MpVFX/files/index.html", "PUT");
    await started.promise;
    const read = request("MpVFX/files/index.html");
    const alias = request("alias/file-mutations/patch-element/index.html", "POST");
    const source = join(projectsDir, "MpVFX/index.html");
    await writeFile(source, "committed content");
    watchers[0].emit("change", source);
    try {
      expect((await request("other/files/index.html")).status).toBe(200);
      expect(calls).toEqual(["/projects/MpVFX/files/index.html", "/projects/other/files/index.html"]);
      expect(onFileChange).not.toHaveBeenCalled();
    } finally {
      finish.release();
    }
    await Promise.all([write, read, alias]);
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({ writeToken: "own-write", version: "committed content" }),
    ));
    expect(calls).toContain("/projects/alias/file-mutations/patch-element/index.html");
  });

  it("does not execute a cancelled queued save and releases the queue after a failed writer", async () => {
    const started = gate();
    const finish = gate();
    const fetch = vi.fn(async (request: Request) => {
      if (request.method === "PUT") {
        started.release();
        await finish.promise;
        return Response.json({ error: "write failed" }, { status: 500 });
      }
      return Response.json({ ok: true });
    });
    const { request } = await setup(fetch);
    const first = request("MpVFX/files/index.html", "PUT");
    await started.promise;
    const abort = new AbortController();
    const cancelled = request("MpVFX/files/index.html", "PUT", abort.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    finish.release();
    expect((await first).status).toBe(500);
    await rejected;
    expect((await request("MpVFX/files/index.html")).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("allows thumbnail capture to read its preview without locking itself out", async () => {
    let readPreview!: () => Promise<Response>;
    const { request } = await setup(async (request) => {
      if (request.url.includes("/thumbnail/")) return readPreview();
      return new Response("preview");
    });
    readPreview = () => request("MpVFX/preview");
    expect(await (await request("MpVFX/thumbnail/index.html")).text()).toBe("preview");
  });
});
