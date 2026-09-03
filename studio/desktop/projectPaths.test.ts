import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDesktopProject, resolveDesktopDataPaths } from "./projectPaths";

describe("desktop project storage", () => {
  it.each(["darwin", "win32", "linux"] as const)(
    "keeps %s projects and working data under Electron userData",
    (platform) => {
      const paths = resolveDesktopDataPaths("/Users/editor/App Data/MpVFX", platform);

      expect(paths).toEqual({
        root: resolve("/Users/editor/App Data/MpVFX"),
        projects: resolve("/Users/editor/App Data/MpVFX/projects"),
        renders: resolve("/Users/editor/App Data/MpVFX/renders"),
        cache: resolve("/Users/editor/App Data/MpVFX/cache"),
        sessions: resolve("/Users/editor/App Data/MpVFX/sessions"),
      });
      expect(Object.values(paths).every((path) => !path.includes("fixtures"))).toBe(true);
    },
  );

  it("bootstraps once and preserves edited projects and recovery data", () => {
    const userData = mkdtempSync(join(tmpdir(), "mpvfx-user-data-"));
    const gsap = join(userData, "gsap.min.js");
    writeFileSync(gsap, "/* local gsap */", "utf8");
    const paths = resolveDesktopDataPaths(userData, process.platform);

    expect(ensureDesktopProject(paths, { gsapSourcePath: gsap }).created).toBe(true);
    const sourcePath = join(paths.projects, "MpVFX", "index.html");
    writeFileSync(sourcePath, "<!doctype html><title>My edited project</title>", "utf8");
    const recovery = join(paths.projects, "MpVFX", ".hyperframes", "recovery.json");
    mkdirSync(join(recovery, ".."), { recursive: true });
    writeFileSync(recovery, "keep", "utf8");

    expect(ensureDesktopProject(paths, { gsapSourcePath: gsap }).created).toBe(false);
    expect(readFileSync(sourcePath, "utf8")).toContain("My edited project");
    expect(readFileSync(recovery, "utf8")).toBe("keep");
  });
});
