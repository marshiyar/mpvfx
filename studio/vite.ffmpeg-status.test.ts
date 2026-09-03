import { describe, expect, it, vi } from "vitest";
import { ffmpegEnvironmentResponse, resolveStandaloneFfmpegStatus } from "./vite.ffmpeg-status";

describe("standalone FFmpeg export capability", () => {
  it("reports an available configured encoder", () => {
    expect(resolveStandaloneFfmpegStatus(() => "/custom/bin/ffmpeg", "darwin")).toEqual({
      ok: true,
    });
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "requires an application reinstall on %s and never offers a system FFmpeg command",
    (platform) => {
      const status = resolveStandaloneFfmpegStatus(() => undefined, platform);
      expect(status).toMatchObject({
        ok: false,
        title: "Bundled media tools unavailable",
        hint: "Reinstall MpVFX to restore its bundled media tools.",
      });
      expect(status).not.toHaveProperty("command");
      expect(JSON.stringify(status)).not.toMatch(/brew|winget|apt install/i);
    },
  );

  it("serves the endpoint used by useFfmpegStatus", async () => {
    const findBinary = vi.fn(() => "/opt/ffmpeg");
    const response = ffmpegEnvironmentResponse(
      "/environment/ffmpeg",
      "GET",
      findBinary,
      "darwin",
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ ok: true });
    expect(findBinary).toHaveBeenCalledWith("ffmpeg", { configuredMustExist: true });
  });

  it("ignores unrelated paths and methods", () => {
    expect(
      ffmpegEnvironmentResponse("/environment/ffmpeg", "POST", () => "/ffmpeg", "darwin"),
    ).toBeNull();
    expect(ffmpegEnvironmentResponse("/projects", "GET", () => "/ffmpeg", "darwin")).toBeNull();
  });
});
