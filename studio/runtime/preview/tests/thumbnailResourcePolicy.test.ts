import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { thumbnailMayReadResource } from "../thumbnailResourcePolicy";

const preview = "http://localhost/api/projects/project%3Acurrent/preview/comp/main.html";
const request = (path: string, method = "GET") =>
  new Request(`https://mpvfx.invalid${path}`, { method });
const root = mkdtempSync(join(tmpdir(), "mpvfx-thumbnail-policy-"));
const projectDir = join(root, "project");
mkdirSync(join(projectDir, "media"), { recursive: true });
writeFileSync(join(projectDir, "index.html"), "<html></html>");
writeFileSync(join(projectDir, "scene.html"), "<html></html>");
writeFileSync(join(projectDir, "media", "sound.wav"), "sound");
writeFileSync(join(root, "outside.txt"), "private");
writeFileSync(join(projectDir, ".env"), "private");
symlinkSync(join(root, "outside.txt"), join(projectDir, "media", "outside.txt"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("thumbnail resource scope", () => {
  it("allows only the captured project's preview tree and shared runtime assets", () => {
    for (const path of [
      "/api/projects/project%3Acurrent/preview",
      "/api/projects/project%3Acurrent/preview/media/sound.wav",
      "/api/projects/project%3Acurrent/preview/comp/scene.html",
      "/api/runtime.js",
      "/api/motion-path-plugin.js",
      "/api/fonts/file?family=Local",
    ]) expect(thumbnailMayReadResource(preview, request(path), projectDir)).toBe(true);
  });

  it("rejects other projects, data APIs, writes and encoded route escapes", () => {
    for (const path of [
      "/api/projects/project%3Aother/preview/secret.txt",
      "/api/projects/project%3Acurrent/files/index.html",
      "/api/projects/project%3Acurrent/previewevil",
      "/api/projects/project%3Acurrent/preview/%2F..%2Fsecret",
      "/api/projects/project%252Fother/preview/index.html",
      "/api/projects/project%3Acurrent/preview/.env",
      "/api/projects/project%3Acurrent/preview/%2eenv",
      "/api/projects/project%3Acurrent/preview/media/outside.txt",
      "/api/projects",
    ]) expect(thumbnailMayReadResource(preview, request(path), projectDir)).toBe(false);
    expect(thumbnailMayReadResource(preview, request(
      "/api/projects/project%3Acurrent/preview", "POST",
    ), projectDir)).toBe(false);
    expect(thumbnailMayReadResource(preview,
      new Request("https://example.invalid/api/projects/project%3Acurrent/preview"), projectDir)).toBe(false);
  });
});
