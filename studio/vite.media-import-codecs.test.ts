import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyUploadedVideoCodecPolicy,
  classifyImportedVideoCodec,
  classifyImportedVideoContainerCodec,
} from "./vite.media-import-codecs";

const tempDirs: string[] = [];

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-codec-import-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "assets"), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("standalone imported-video codec policy", () => {
  it.each(["h264", "vp8"])("allows browser-safe %s directly", (codec) => {
    expect(classifyImportedVideoCodec(codec)).toBe("direct");
  });

  it.each(["hevc", "prores", "av1", "vp9"])("allows %s through the preview proxy", (codec) => {
    expect(classifyImportedVideoCodec(codec)).toBe("proxy");
  });

  it.each(["mpeg2video", "mpeg4", "dvvideo", "mjpeg", "theora", "unknown"])(
    "rejects unhandled codec %s instead of pretending it is browser-safe",
    (codec) => {
      expect(classifyImportedVideoCodec(codec)).toBe("unsupported");
    },
  );

  it.each([
    ["assets/clip.mp4", "h264", "mov,mp4,m4a,3gp,3g2,mj2", "direct"],
    ["assets/clip.m4v", "hevc", "mov,mp4,m4a,3gp,3g2,mj2", "proxy"],
    ["assets/clip.mov", "prores", "mov,mp4,m4a,3gp,3g2,mj2", "proxy"],
    ["assets/clip.webm", "vp8", "matroska,webm", "direct"],
    ["assets/clip.webm", "vp9", "matroska,webm", "proxy"],
    ["assets/clip.webm", "av1", "matroska,webm", "proxy"],
  ] as const)(
    "accepts canonical %s + %s imports as %s",
    (path, codecName, containerName, support) => {
      expect(
        classifyImportedVideoContainerCodec(path, { codecName, containerName }),
      ).toBe(support);
    },
  );

  it.each([
    ["assets/renamed.webm", "h264", "mov,mp4,m4a,3gp,3g2,mj2"],
    ["assets/renamed.mp4", "vp8", "matroska,webm"],
    ["assets/renamed.mov", "vp8", "matroska,webm"],
    ["assets/impossible.webm", "prores", "matroska,webm"],
    ["assets/clip.mp4", "h264", "matroska,webm"],
    ["assets/clip.webm", "vp8", "mov,mp4,m4a,3gp,3g2,mj2"],
  ] as const)(
    "rejects mismatched codec/container import %s (%s in %s)",
    (path, codecName, containerName) => {
      expect(
        classifyImportedVideoContainerCodec(path, { codecName, containerName }),
      ).toBe("unsupported");
    },
  );

  it("removes unsupported videos from a mixed successful upload response", async () => {
    const dir = projectDir();
    for (const path of ["assets/good.mp4", "assets/proxied.mov", "assets/bad.mov", "assets/voice.aac"]) {
      writeFileSync(join(dir, path), path);
    }
    const response = new Response(
      JSON.stringify({
        ok: true,
        files: ["assets/good.mp4", "assets/proxied.mov", "assets/bad.mov", "assets/voice.aac"],
        skipped: [],
        invalid: [{ name: "already-invalid.mp4", reason: "bad stream" }],
      }),
      { status: 201, headers: { "Content-Type": "application/json", "Content-Length": "999" } },
    );

    const filtered = await applyUploadedVideoCodecPolicy({
      requestPath: "/projects/project/upload",
      response,
      resolveProject: async () => ({ dir }),
      probeVideo: async (path) => {
        if (path.endsWith("good.mp4")) {
          return { codecName: "h264", containerName: "mov,mp4,m4a,3gp,3g2,mj2" };
        }
        if (path.endsWith("proxied.mov")) {
          return { codecName: "prores", containerName: "mov,mp4,m4a,3gp,3g2,mj2" };
        }
        if (path.endsWith("bad.mov")) {
          return { codecName: "dvvideo", containerName: "mov,mp4,m4a,3gp,3g2,mj2" };
        }
        return null;
      },
    });
    const payload = await filtered.json();

    expect(payload.files).toEqual(["assets/good.mp4", "assets/proxied.mov", "assets/voice.aac"]);
    expect(payload.invalid).toEqual([
      { name: "already-invalid.mp4", reason: "bad stream" },
      { name: "assets/bad.mov", reason: "unsupported video codec: dvvideo" },
    ]);
    expect(existsSync(join(dir, "assets/bad.mov"))).toBe(false);
    expect(existsSync(join(dir, "assets/good.mp4"))).toBe(true);
    expect(filtered.headers.get("Content-Length")).toBeNull();
  });

  it("rejects a video whose codec cannot be verified", async () => {
    const dir = projectDir();
    writeFileSync(join(dir, "assets/unknown.mp4"), "video");
    const response = new Response(
      JSON.stringify({ ok: true, files: ["assets/unknown.mp4"], skipped: [], invalid: [] }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );

    const filtered = await applyUploadedVideoCodecPolicy({
      requestPath: "/projects/project/upload",
      response,
      resolveProject: () => ({ dir }),
      probeVideo: async () => null,
    });

    expect(await filtered.json()).toMatchObject({
      files: [],
      invalid: [
        { name: "assets/unknown.mp4", reason: "video codec could not be verified" },
      ],
    });
    expect(existsSync(join(dir, "assets/unknown.mp4"))).toBe(false);
  });

  it("does not inspect non-upload responses", async () => {
    const response = new Response("plain", { status: 200, headers: { "Content-Type": "text/plain" } });
    const result = await applyUploadedVideoCodecPolicy({
      requestPath: "/projects/project/preview/assets/clip.mp4",
      response,
      resolveProject: () => {
        throw new Error("should not resolve a project");
      },
      probeVideo: async () => {
        throw new Error("should not probe");
      },
    });
    await expect(result.text()).resolves.toBe("plain");
  });

  it("removes a renamed video whose real container does not match its extension", async () => {
    const dir = projectDir();
    writeFileSync(join(dir, "assets/renamed.webm"), "mp4 bytes");
    const response = new Response(
      JSON.stringify({ ok: true, files: ["assets/renamed.webm"], skipped: [], invalid: [] }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );

    const filtered = await applyUploadedVideoCodecPolicy({
      requestPath: "/projects/project/upload",
      response,
      resolveProject: () => ({ dir }),
      probeVideo: async () => ({
        codecName: "h264",
        containerName: "mov,mp4,m4a,3gp,3g2,mj2",
      }),
    });

    expect(await filtered.json()).toMatchObject({
      files: [],
      invalid: [
        {
          name: "assets/renamed.webm",
          reason: "unsupported video codec/container combination: h264 in mov,mp4,m4a,3gp,3g2,mj2",
        },
      ],
    });
    expect(existsSync(join(dir, "assets/renamed.webm"))).toBe(false);
  });

  it("uses the configured ffprobe path for the default codec and container probes", async () => {
    const dir = projectDir();
    const configuredFfprobe = join(dir, "configured-ffprobe");
    writeFileSync(
      configuredFfprobe,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p"}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2"}}\'\n',
    );
    chmodSync(configuredFfprobe, 0o755);
    writeFileSync(join(dir, "assets/configured.mp4"), "fixture bytes");
    const previous = process.env.HYPERFRAMES_FFPROBE_PATH;
    const previousRoot = process.env.MPVFX_BUNDLED_MEDIA_ROOT;
    process.env.HYPERFRAMES_FFPROBE_PATH = configuredFfprobe;
    process.env.MPVFX_BUNDLED_MEDIA_ROOT = dir;

    try {
      const filtered = await applyUploadedVideoCodecPolicy({
        requestPath: "/projects/project/upload",
        response: new Response(
          JSON.stringify({
            ok: true,
            files: ["assets/configured.mp4"],
            skipped: [],
            invalid: [],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
        resolveProject: () => ({ dir }),
      });

      expect(await filtered.json()).toMatchObject({
        files: ["assets/configured.mp4"],
        invalid: [],
      });
      expect(existsSync(join(dir, "assets/configured.mp4"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HYPERFRAMES_FFPROBE_PATH;
      else process.env.HYPERFRAMES_FFPROBE_PATH = previous;
      if (previousRoot === undefined) delete process.env.MPVFX_BUNDLED_MEDIA_ROOT;
      else process.env.MPVFX_BUNDLED_MEDIA_ROOT = previousRoot;
    }
  });
});
