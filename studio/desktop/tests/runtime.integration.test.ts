import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { DESKTOP_CHANNELS } from "../../shared/desktopBridge";

const transport = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
  resource: undefined as undefined | ((request: Request) => Promise<Response>),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => transport.handlers.set(channel, handler),
    on: (channel: string, handler: (...args: any[]) => any) => transport.listeners.set(channel, handler),
    removeHandler: (channel: string) => transport.handlers.delete(channel),
    removeListener: (channel: string) => transport.listeners.delete(channel),
  },
  protocol: {
    handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => { transport.resource = handler; },
    unhandle: () => { transport.resource = undefined; },
  },
}));
import { startEditorRuntime } from "../editorRuntime";
import { resolveInstalledMediaBinaryPaths } from "../installedMediaBinaries";

const contents = Object.assign(new EventEmitter(), {
  id: 1, mainFrame: { url: "mpvfx://editor/" },
  isDestroyed: () => false,
  send: vi.fn(),
});
const event = { sender: contents, senderFrame: contents.mainFrame };
const roots: string[] = [];
function temporaryRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
async function command(url: string, init?: RequestInit) {
  const request = new Request(url, init);
  const parsed = new URL(url);
  const result = await transport.handlers.get(DESKTOP_CHANNELS.request)!(event, {
    id: crypto.randomUUID(), path: parsed.pathname + parsed.search, method: request.method,
    headers: Array.from(request.headers), body: request.body ? await request.arrayBuffer() : undefined,
  });
  return new Response(result.body, result);
}
function resource(url: string, init?: RequestInit) {
  return transport.resource!(new Request(url, init));
}

const running: Awaited<ReturnType<typeof startEditorRuntime>>[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((runtime) => runtime.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  contents.removeAllListeners();
  contents.send.mockClear();
  vi.unstubAllEnvs();
});

describe("desktop IPC and resources", () => {
  it("decodes ProRes through native IPC without reading or rewriting a composition", async () => {
    const root = temporaryRoot("mpvfx-native-decode-");
    const { ffmpegPath, ffprobePath } = resolveInstalledMediaBinaryPaths();
    vi.stubEnv("HYPERFRAMES_FFMPEG_PATH", ffmpegPath);
    vi.stubEnv("HYPERFRAMES_FFPROBE_PATH", ffprobePath);
    vi.stubEnv("MPVFX_BUNDLED_MEDIA_ROOT", resolve("node_modules"));
    const server = await startEditorRuntime({ staticDir: root, projectsDir: join(root, "projects"), studioDir: resolve("."), editorContents: () => contents as any });
    running.push(server);
    const projectDir = join(root, "projects", "MpVFX");
    const sourceBefore = readFileSync(join(projectDir, "index.html"), "utf8");
    execFileSync(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x64:rate=10:duration=1", "-c:v", "prores_ks", "-pix_fmt", "yuv422p10le", join(projectDir, "clip.mov")]);
    const response = await command("mpvfx://editor/api/projects/MpVFX/media/frames", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "clip.mov", frameCount: 1, width: 120, height: 80 }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ aspect: 2, width: 120, height: 60, duration: 1 });
    expect(Buffer.from(result.frames[0], "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(readFileSync(join(projectDir, "index.html"), "utf8")).toBe(sourceBefore);
  });

  it("serves the built UI and real project, preview, runtime, and media APIs without HTTP", async () => {
    const root = temporaryRoot("mpvfx-desktop-runtime-");
    const staticDir = join(root, "dist");
    const projectsDir = join(root, "projects");
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    writeFileSync(join(staticDir, "index.html"), '<script src="/assets/app.js"></script>');
    writeFileSync(join(staticDir, "assets", "app.js"), "window.editorLoaded=true");
    const server = await startEditorRuntime({
      staticDir,
      projectsDir,
      studioDir: resolve("."),
      editorContents: () => contents as any,
    });
    running.push(server);

    expect(server.origin).toBe("mpvfx://editor/");
    const shell = await resource(`${server.origin.slice(0, -1)}/`);
    expect(await shell.text()).toContain("/assets/app.js");
    expect(shell.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(shell.headers.get("content-security-policy")).not.toContain("unsafe-eval");
    const editorAsset = await resource(`${server.origin.slice(0, -1)}/assets/app.js`);
    expect(await editorAsset.text()).toContain("editorLoaded");
    expect(shell.headers.get("cache-control")).toBe("no-store");
    expect(editorAsset.headers.get("cache-control")).toBe("no-store");

    const projectsResponse = await command(`${server.origin.slice(0, -1)}/api/projects`);
    expect(projectsResponse.status).toBe(200);
    expect(await projectsResponse.json()).toMatchObject({
      projects: [expect.objectContaining({ id: "MpVFX" })],
    });

    // The shared upstream API includes agent selection context, but the
    // standalone editor must neither accept nor expose those snapshots.
    for (const method of ["GET", "PUT"]) {
      const agentSelection = await command(`${server.origin.slice(0, -1)}/api/projects/MpVFX/selection`, {
        method,
        ...(method === "PUT" ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selection: null }),
        } : {}),
      });
      expect(agentSelection.status).toBe(404);
    }

    const uploadBody = new FormData();
    uploadBody.append(
      "files",
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], {
        type: "image/png",
      }),
      "still.png",
    );
    const upload = await command(`${server.origin.slice(0, -1)}/api/projects/MpVFX/upload?dir=assets`, {
      method: "POST",
      body: uploadBody,
    });
    expect(upload.status).toBe(201);
    expect(await upload.json()).toMatchObject({ ok: true, files: ["assets/still.png"] });
    const uploadedAsset = await resource(
      `${server.origin.slice(0, -1)}/api/projects/MpVFX/preview/assets/still.png`,
    );
    expect(uploadedAsset.status).toBe(200);
    expect(new Uint8Array(await uploadedAsset.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );

    const preview = await resource(`${server.origin.slice(0, -1)}/api/projects/MpVFX/preview`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('/api/runtime.js');
    const runtime = await resource(`${server.origin.slice(0, -1)}/api/runtime.js`);
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get("content-type")).toContain("text/javascript");
    expect(await runtime.text()).toContain("__studioNativePlayer?.reapplyFrame?.()");
    const motionPathPlugin = await resource(`${server.origin.slice(0, -1)}/api/motion-path-plugin.js`);
    expect(motionPathPlugin.status).toBe(200);
    expect(await motionPathPlugin.text()).toContain("MotionPathPlugin");

    const mediaPath = join(projectsDir, "MpVFX", "assets", "sample.mp4");
    mkdirSync(join(mediaPath, ".."), { recursive: true });
    writeFileSync(mediaPath, Buffer.from([0, 1, 2, 3, 4, 5]));
    const media = await resource(
      `${server.origin.slice(0, -1)}/api/projects/MpVFX/preview/assets/sample.mp4`,
      { headers: { Range: "bytes=2-4" } },
    );
    expect(media.status).toBe(206);
    expect(media.headers.get("content-type")).toContain("video/mp4");
    expect(Array.from(new Uint8Array(await media.arrayBuffer()))).toEqual([2, 3, 4]);
  });

  it("does not expose files outside the renderer build", async () => {
    const root = temporaryRoot("mpvfx-static-security-");
    const staticDir = join(root, "dist");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "editor");
    writeFileSync(join(root, "secret.txt"), "not public");
    const server = await startEditorRuntime({
      staticDir,
      projectsDir: join(root, "projects"),
      studioDir: resolve("."),
      editorContents: () => contents as any,
    });
    running.push(server);

    const traversal = await resource(`${server.origin.slice(0, -1)}/%2e%2e/secret.txt`);
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain("not public");

    symlinkSync(join(root, "secret.txt"), join(staticDir, "leak.txt"));
    expect((await resource(`${server.origin}leak.txt`)).status).toBe(404);
    expect((await resource(`${server.origin}api/projects`)).status).toBe(403);
    expect((await resource(`${server.origin}api/projects/MpVFX/upload`, { method: "POST" })).status).toBe(405);
    for (const senderFrame of [{ url: "https://attacker.example" }, { url: "mpvfx://editor/api/projects/MpVFX/preview" }]) {
      await expect(transport.handlers.get(DESKTOP_CHANNELS.request)!({ ...event, senderFrame }, {
        id: "bad", path: "/api/projects", method: "GET", headers: [],
      })).rejects.toThrow("Untrusted");
    }
  });

  it("delivers project changes through IPC and stops after unsubscribe", async () => {
    const root = temporaryRoot("mpvfx-events-");
    const staticDir = join(root, "dist");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "editor");
    const projectsDir = join(root, "projects");
    const server = await startEditorRuntime({
      staticDir,
      projectsDir,
      studioDir: resolve("."),
      editorContents: () => contents as any,
    });
    running.push(server);

    await transport.handlers.get(DESKTOP_CHANNELS.subscribe)!(event, "files", "/api/events");
    const composition = join(projectsDir, "MpVFX", "index.html");
    writeFileSync(composition, "<!doctype html><title>changed</title>", "utf8");
    await vi.waitFor(() => expect(contents.send).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.event, "files", expect.objectContaining({
        type: "file-change", data: expect.stringContaining("index.html"),
      }),
    ), { timeout: 10_000 });
    transport.listeners.get(DESKTOP_CHANNELS.unsubscribe)!(event, "files");
    contents.send.mockClear();
    writeFileSync(composition, "<!doctype html><title>changed again</title>", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(contents.send).not.toHaveBeenCalled();
  }, 15_000);
});
