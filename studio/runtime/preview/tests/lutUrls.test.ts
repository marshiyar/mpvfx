import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStudioRuntime, type StudioRuntime } from "../../service";
import { enableStandaloneLutUrls } from "../lutUrls";

type LutResult = { href: string } | { error: string };
const desktopPage = "mpvfx://editor/api/projects/demo/preview/index.html";
let runtime: StudioRuntime;
let projectsDir: string;
let servedSource: string;

/** Execute the resolver from the actual served bundle, not a duplicate URL policy. */
function resolver(source: string, page = desktopPage, baseURI = page) {
  const match = source.match(/function ([\w$]+)\(e\)\{try\{let t=new URL\(e,document\.baseURI\);[\s\S]*?catch\{return\{error:"Invalid LUT URL"\}\}\}/);
  if (!match) throw new Error("Installed LUT URL resolver boundary changed");
  return new Function("document", "window", `${match[0]};return ${match[1]};`)(
    { baseURI },
    { location: new URL(page) },
  ) as (src: string) => LutResult;
}

beforeAll(async () => {
  projectsDir = await mkdtemp(join(tmpdir(), "lut-runtime-"));
  runtime = createStudioRuntime({
    projectsDir,
    adapterHost: {
      studioDir: projectsDir,
      loadModule: async () => { throw new Error("Runtime asset must not load the project API"); },
    },
  });
  const response = await runtime.handle(new Request("mpvfx://editor/api/runtime.js"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/javascript");
  servedSource = await response.text();
});

afterAll(async () => {
  await runtime?.close();
  if (projectsDir) await rm(projectsDir, { recursive: true, force: true });
});

describe("LUT URLs in the packaged preview runtime", () => {
  it.each([
    "assets/luts/identity.cube",
    "mpvfx://editor/api/projects/demo/preview/assets/luts/identity.cube",
    "/api/projects/demo/preview/assets/luts/identity.cube",
  ])("loads desktop project LUT %s", (src) => {
    expect(resolver(servedSource)(src)).toEqual({ href: new URL(src, desktopPage).href });
  });

  it.each([
    "mpvfx://other/assets/lut.cube",
    "mpvfx://editor.evil/assets/lut.cube",
    "mpvfx://editor:9999/assets/lut.cube",
    "https://editor/assets/lut.cube",
    "http://editor/assets/lut.cube",
  ])("rejects a desktop LUT from another host or protocol: %s", (src) => {
    expect(resolver(servedSource)(src)).toEqual({ error: "Remote LUT URLs are not supported" });
  });

  it("does not treat opaque origins as evidence that hosts match", () => {
    expect(new URL("mpvfx://other/lut.cube").origin).toBe(new URL(desktopPage).origin);
    expect(resolver(servedSource)("mpvfx://other/lut.cube")).toHaveProperty("error");
  });

  it("rejects relative assets when a document base points to another host", () => {
    expect(resolver(servedSource, desktopPage, "mpvfx://other/preview/")("assets/lut.cube"))
      .toEqual({ error: "Remote LUT URLs are not supported" });
  });

  it.each(["file:///tmp/lut.cube", "blob:mpvfx://editor/example", "javascript:alert(1)", "ftp://editor/lut.cube"])(
    "still rejects arbitrary schemes: %s", (src) => {
      expect(resolver(servedSource)(src)).toEqual({ error: "LUT must be project-local or a data URL" });
    },
  );

  it.each(["http://localhost:3000/preview/index.html", "https://editor.example/preview/index.html"])(
    "preserves existing same-origin web LUT behavior at %s", (page) => {
      const resolve = resolver(servedSource, page);
      expect(resolve("assets/lut.cube")).toEqual({ href: new URL("assets/lut.cube", page).href });
      expect(resolve("https://remote.example/lut.cube")).toEqual({ error: "Remote LUT URLs are not supported" });
      expect(resolve("mpvfx://editor/assets/lut.cube")).toHaveProperty("error");
      const differentProtocol = new URL(page);
      differentProtocol.protocol = differentProtocol.protocol === "http:" ? "https:" : "http:";
      expect(resolve(differentProtocol.href)).toEqual({ error: "Remote LUT URLs are not supported" });
    },
  );

  it("preserves data URLs and invalid-URL errors", () => {
    const resolve = resolver(servedSource);
    expect(resolve("data:text/plain,LUT_3D_SIZE%202")).toEqual({ href: "data:text/plain,LUT_3D_SIZE%202" });
    expect(resolve("http://[")).toEqual({ error: "Invalid LUT URL" });
  });
});

describe("installed LUT resolver compatibility boundary", () => {
  const require = createRequire(import.meta.url);
  const runtimePaths = [
    require.resolve("@hyperframes/core/runtime"),
    join(dirname(require.resolve("@hyperframes/producer/server")), "hyperframe.runtime.iife.js"),
  ];

  it.each(runtimePaths)("changes exactly one known resolver and is idempotent: %s", (path) => {
    const original = readFileSync(path, "utf8");
    const transformed = enableStandaloneLutUrls(original);
    expect(transformed).not.toBe(original);
    expect(enableStandaloneLutUrls(transformed)).toBe(transformed);
    expect(() => new Function(transformed)).not.toThrow();
    expect(resolver(transformed)("assets/luts/identity.cube"))
      .toEqual({ href: new URL("assets/luts/identity.cube", desktopPage).href });
    expect(resolver(transformed)("mpvfx://other/assets/luts/identity.cube"))
      .toEqual({ error: "Remote LUT URLs are not supported" });
  });

  it("rejects missing, duplicated, and mixed original/patched boundaries", () => {
    const original = readFileSync(runtimePaths[0], "utf8");
    const transformed = enableStandaloneLutUrls(original);
    for (const source of ["changed runtime", original + original, transformed + transformed, original + transformed]) {
      expect(() => enableStandaloneLutUrls(source)).toThrow("must occur exactly once");
    }
  });
});
