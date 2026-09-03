import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteStandaloneCompositionResponse } from "./vite.composition-delete";

const roots: string[] = [];
const versionOf = (content: string) => `version:${content}`;

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "studio-scene-delete-"));
  roots.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return { id: "demo", dir };
}

function request(
  resolvedProject: { id: string; dir: string },
  path: string,
  expectedVersion: string,
) {
  return deleteStandaloneCompositionResponse({
    method: "POST",
    pathname: `/projects/demo/file-mutations/delete-composition/${encodeURIComponent(path)}`,
    body: Buffer.from(JSON.stringify({ expectedVersion })),
    resolveProject: async () => resolvedProject,
    versionOf,
    now: () => 1234,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone reusable-scene deletion", () => {
  it("moves an unreferenced scene into a recoverable archive", async () => {
    const resolved = project({
      "index.html": '<main data-composition-id="master"></main>',
      "compositions/intro.html": '<main data-composition-id="intro"></main>',
    });
    const source = readFileSync(join(resolved.dir, "compositions/intro.html"), "utf8");

    const response = await request(resolved, "compositions/intro.html", versionOf(source));
    const result = (await response?.json()) as { ok?: boolean; backupPath?: string };

    expect(response?.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.backupPath).toMatch(/^\.hyperframes\/deleted-scenes\//);
    expect(existsSync(join(resolved.dir, "compositions/intro.html"))).toBe(false);
    expect(existsSync(join(resolved.dir, result.backupPath ?? "missing"))).toBe(true);
  });

  it("never deletes the master timeline", async () => {
    const source = '<main data-composition-id="master"></main>';
    const resolved = project({ "index.html": source });

    const response = await request(resolved, "index.html", versionOf(source));

    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ error: "The main timeline cannot be deleted" });
    expect(existsSync(join(resolved.dir, "index.html"))).toBe(true);
  });

  it("protects a project-named master timeline", async () => {
    const source = '<main data-composition-id="master"></main>';
    const resolved = project({ "demo.html": source });

    const response = await request(resolved, "demo.html", versionOf(source));

    expect(response?.status).toBe(403);
    expect(existsSync(join(resolved.dir, "demo.html"))).toBe(true);
  });

  it("refuses every deletion when the project has no identifiable master timeline", async () => {
    const scene = '<main data-composition-id="intro"></main>';
    const resolved = project({
      "notes.html": "<p>ordinary HTML</p>",
      "compositions/intro.html": scene,
    });

    const response = await request(resolved, "compositions/intro.html", versionOf(scene));

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      error: "Project main timeline could not be identified",
    });
    expect(existsSync(join(resolved.dir, "compositions/intro.html"))).toBe(true);
  });

  it("refuses to delete a scene that another composition still uses", async () => {
    const scene = '<main data-composition-id="intro"></main>';
    const resolved = project({
      "index.html":
        '<main data-composition-id="master"><div data-composition-src="compositions/intro.html"></div></main>',
      "compositions/intro.html": scene,
    });

    const response = await request(resolved, "compositions/intro.html", versionOf(scene));

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      error: "Scene is still used by another composition",
      dependents: ["index.html"],
    });
    expect(existsSync(join(resolved.dir, "compositions/intro.html"))).toBe(true);
  });

  it("recognizes an unquoted composition reference before deletion", async () => {
    const scene = '<main data-composition-id="intro"></main>';
    const resolved = project({
      "index.html":
        '<main data-composition-id="master"><div data-composition-src=compositions/intro.html></div></main>',
      "compositions/intro.html": scene,
    });

    const response = await request(resolved, "compositions/intro.html", versionOf(scene));

    expect(response?.status).toBe(409);
    expect(existsSync(join(resolved.dir, "compositions/intro.html"))).toBe(true);
  });

  it("refuses stale, malformed, non-composition, and escaping requests", async () => {
    const scene = '<main data-composition-id="intro"></main>';
    const resolved = project({
      "index.html": '<main data-composition-id="master"></main>',
      "compositions/intro.html": scene,
      "notes.html": "<p>not a composition</p>",
    });

    const stale = await request(resolved, "compositions/intro.html", "stale");
    const notComposition = await request(
      resolved,
      "notes.html",
      versionOf("<p>not a composition</p>"),
    );
    const escaping = await request(resolved, "../outside.html", "anything");

    expect(stale?.status).toBe(409);
    expect(await stale?.json()).toMatchObject({ error: "Scene changed before deletion" });
    expect(notComposition?.status).toBe(400);
    expect(await notComposition?.json()).toMatchObject({ error: "File is not a composition" });
    expect(escaping?.status).toBe(403);
  });

  it("ignores unrelated methods and paths so the shared API can handle them", async () => {
    const resolved = project({ "index.html": '<main data-composition-id="master"></main>' });
    const response = await deleteStandaloneCompositionResponse({
      method: "GET",
      pathname: "/projects/demo",
      resolveProject: async () => resolved,
      versionOf,
    });
    expect(response).toBeNull();
  });

  it("rejects a project id that attempts to escape the configured project namespace", async () => {
    const scene = '<main data-composition-id="intro"></main>';
    const resolved = project({
      "index.html": '<main data-composition-id="master"></main>',
      "compositions/intro.html": scene,
    });
    let resolvedUnsafeId = false;
    const response = await deleteStandaloneCompositionResponse({
      method: "POST",
      pathname: `/projects/${encodeURIComponent("../outside")}/file-mutations/delete-composition/${encodeURIComponent("compositions/intro.html")}`,
      body: Buffer.from(JSON.stringify({ expectedVersion: versionOf(scene) })),
      resolveProject: async () => {
        resolvedUnsafeId = true;
        return resolved;
      },
      versionOf,
    });

    expect(response?.status).toBe(403);
    expect(resolvedUnsafeId).toBe(false);
    expect(existsSync(join(resolved.dir, "compositions/intro.html"))).toBe(true);
  });

  it.each([".hyperframes", ".hyperframes/deleted-scenes"])(
    "does not follow a project-controlled %s archive symlink",
    async (symlinkPath) => {
      const scene = '<main data-composition-id="intro"></main>';
      const resolved = project({
        "index.html": '<main data-composition-id="master"></main>',
        "compositions/intro.html": scene,
      });
      const outside = mkdtempSync(join(tmpdir(), "studio-scene-delete-outside-"));
      roots.push(outside);
      if (symlinkPath.includes("/")) mkdirSync(join(resolved.dir, ".hyperframes"));
      symlinkSync(outside, join(resolved.dir, symlinkPath));

      const response = await request(resolved, "compositions/intro.html", versionOf(scene));

      expect(response?.status).toBe(500);
      expect(await response?.json()).toMatchObject({
        error: "Could not archive the scene; nothing was deleted",
      });
      expect(existsSync(join(resolved.dir, "compositions/intro.html"))).toBe(true);
      expect(readdirSync(outside)).toEqual([]);
    },
  );
});
