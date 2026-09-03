import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStudioServer, type RunningStudioServer } from "./editorServer";

const running: RunningStudioServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

describe("packaged editor server", () => {
  it("serves the built UI and real project, preview, runtime, and media APIs on loopback", async () => {
    const root = mkdtempSync(join(tmpdir(), "mpvfx-desktop-server-"));
    const staticDir = join(root, "dist");
    const projectsDir = join(root, "projects");
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    writeFileSync(join(staticDir, "index.html"), '<script src="/assets/app.js"></script>');
    writeFileSync(join(staticDir, "assets", "app.js"), "window.editorLoaded=true");
    const server = await startStudioServer({
      staticDir,
      projectsDir,
      studioDir: resolve("."),
      version: "test",
    });
    running.push(server);

    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const shell = await fetch(`${server.origin}/`);
    expect(await shell.text()).toContain("/assets/app.js");
    expect(shell.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(shell.headers.get("content-security-policy")).not.toContain("unsafe-eval");
    const editorAsset = await fetch(`${server.origin}/assets/app.js`);
    expect(await editorAsset.text()).toContain("editorLoaded");
    expect(shell.headers.get("cache-control")).toBe("no-store");
    expect(editorAsset.headers.get("cache-control")).toBe("no-store");

    const projectsResponse = await fetch(`${server.origin}/api/projects`);
    expect(projectsResponse.status).toBe(200);
    expect(await projectsResponse.json()).toMatchObject({
      projects: [expect.objectContaining({ id: "MpVFX" })],
    });

    const uploadBody = new FormData();
    uploadBody.append(
      "files",
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], {
        type: "image/png",
      }),
      "still.png",
    );
    const upload = await fetch(`${server.origin}/api/projects/MpVFX/upload?dir=assets`, {
      method: "POST",
      body: uploadBody,
    });
    expect(upload.status).toBe(201);
    expect(await upload.json()).toMatchObject({ ok: true, files: ["assets/still.png"] });
    const uploadedAsset = await fetch(
      `${server.origin}/api/projects/MpVFX/preview/assets/still.png`,
    );
    expect(uploadedAsset.status).toBe(200);
    expect(new Uint8Array(await uploadedAsset.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );

    const preview = await fetch(`${server.origin}/api/projects/MpVFX/preview`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('/api/runtime.js');
    const runtime = await fetch(`${server.origin}/api/runtime.js`);
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get("content-type")).toContain("text/javascript");
    const motionPathPlugin = await fetch(`${server.origin}/api/motion-path-plugin.js`);
    expect(motionPathPlugin.status).toBe(200);
    expect(await motionPathPlugin.text()).toContain("MotionPathPlugin");

    const mediaPath = join(projectsDir, "MpVFX", "assets", "sample.mp4");
    mkdirSync(join(mediaPath, ".."), { recursive: true });
    writeFileSync(mediaPath, Buffer.from([0, 1, 2, 3, 4, 5]));
    const media = await fetch(
      `${server.origin}/api/projects/MpVFX/preview/assets/sample.mp4`,
      { headers: { Range: "bytes=2-4" } },
    );
    expect(media.status).toBe(206);
    expect(media.headers.get("content-type")).toContain("video/mp4");
    expect(Array.from(new Uint8Array(await media.arrayBuffer()))).toEqual([2, 3, 4]);
  });

  it("does not expose files outside the renderer build", async () => {
    const root = mkdtempSync(join(tmpdir(), "mpvfx-static-security-"));
    const staticDir = join(root, "dist");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "editor");
    writeFileSync(join(root, "secret.txt"), "not public");
    const server = await startStudioServer({
      staticDir,
      projectsDir: join(root, "projects"),
      studioDir: resolve("."),
      version: "test",
    });
    running.push(server);

    const traversal = await fetch(`${server.origin}/%2e%2e/secret.txt`);
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain("not public");

    const crossOriginMutation = await fetch(`${server.origin}/api/projects/MpVFX/upload`, {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
      body: "untrusted",
    });
    expect(crossOriginMutation.status).toBe(403);
  });

  it("delivers project changes through the production event stream", async () => {
    const root = mkdtempSync(join(tmpdir(), "mpvfx-events-"));
    const staticDir = join(root, "dist");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "editor");
    const projectsDir = join(root, "projects");
    const server = await startStudioServer({
      staticDir,
      projectsDir,
      studioDir: resolve("."),
      version: "test",
    });
    running.push(server);

    const controller = new AbortController();
    const stream = await fetch(`${server.origin}/api/events`, { signal: controller.signal });
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let received = decoder.decode((await reader!.read()).value);
    const composition = join(projectsDir, "MpVFX", "index.html");
    writeFileSync(composition, "<!doctype html><title>changed</title>", "utf8");

    await Promise.race([
      (async () => {
        while (!received.includes("index.html")) {
          const next = await reader!.read();
          if (next.done) break;
          received += decoder.decode(next.value);
        }
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("file-change event timed out")), 10_000),
      ),
    ]);
    expect(received).toContain("event: file-change");
    expect(received).toContain("index.html");
    controller.abort();
  }, 15_000);
});
