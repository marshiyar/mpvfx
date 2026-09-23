import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseNativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { planMediaReferences } from "../mediaReferences";

const roots: string[] = [];
async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "mpvfx-media-references-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function nativeDocument() {
  return parseNativeProjectDocument({
    schemaVersion: 1,
    id: "project:demo",
    revision: 4,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [{ id: "asset:media/a.mov", name: "media/a.mov", kind: "video", source: "media/a.mov", durationFrames: 120 }],
    sequence: { id: "sequence:main", name: "Main", tracks: [{
      id: "track:1", kind: "video", lane: { authoredTrack: 0, displayTrack: 0 }, clips: [{
        id: "clip:media/a.mov", assetId: "asset:media/a.mov", binding: { sourceFile: "index.html", domId: "media/a.mov" },
        startFrame: 0, sourceInFrame: 0, durationFrames: 60, muted: false, effects: [], parameterTracks: [],
      }],
    }] },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("owned media reference planning", () => {
  it("changes the native location and only authored URL spans, preserving identities and recovery records", async () => {
    const document = nativeDocument();
    const html = `<!doctype html>\n<!-- <video src="media/a.mov"> -->\n<div id="media/a.mov">media/a.mov</div>\n<video  src = 'media/a.mov' data-label="media/a.mov" poster="media/a.mov.bak"></video>\n`;
    const journal = '{"checksum":"do-not-change","before":"media/a.mov"}';
    const root = await project({
      "index.html": html,
      ".studio/project.json": JSON.stringify(document),
      ".hyperframes/studio-transactions/receipt.json": journal,
      ".hyperframes/undo/index.html": '<video src="media/a.mov">',
      "README.md": 'Media example: "media/a.mov"',
      "node_modules/example/example.html": '<video src="media/a.mov">',
      "renders/old.html": '<video src="media/a.mov">',
    });
    const result = await planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a.mov", newPath: "media/renamed file.mov" });
    expect(result.dependents).toEqual([".studio/project.json", "index.html"]);
    expect(result.files.map(file => file.path).sort()).toEqual([".studio/project.json", "index.html"]);
    expect(result.files.find(file => file.path === "index.html")?.after).toBe(html.replace("src = 'media/a.mov'", "src = 'media/renamed%20file.mov'"));
    const updated = JSON.parse(result.files.find(file => file.path === ".studio/project.json")!.after!);
    expect(updated).toEqual({ ...document, revision: 5, assets: [{ ...document.assets[0], source: "media/renamed file.mov" }] });
    expect(await readFile(join(root, "index.html"), "utf8")).toBe(html);
    expect(await readFile(join(root, ".hyperframes/studio-transactions/receipt.json"), "utf8")).toBe(journal);
  });

  it("resolves nested owners and preserves same-project transport URLs, suffixes, and HTML entities", async () => {
    const html = `<video src="../media/a%20%26%20b.mov?v=1&amp;quality=2#t=1"></video>
<video src="mpvfx://editor/api/projects/demo/preview/media/a%20%26%20b.mov?version=2"></video>
<audio src=/api/projects/demo/preview/media/a%20%26%20b.mov></audio>
<video src="mpvfx://editor/api/projects/other/preview/media/a%20%26%20b.mov"></video>
<video src="https://example.com/media/a%20%26%20b.mov"></video>`;
    const root = await project({ "compositions/nested.html": html });
    const result = await planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a & b.mov", newPath: "renamed/new.mov" });
    expect(result.files[0]?.after).toBe(html
      .replace("../media/a%20%26%20b.mov?v=1", "../renamed/new.mov?v=1")
      .replace("projects/demo/preview/media/a%20%26%20b.mov", "projects/demo/preview/renamed/new.mov")
      .replace("projects/demo/preview/media/a%20%26%20b.mov", "projects/demo/preview/renamed/new.mov"));
  });

  it("updates CSS URL tokens but never comments, strings, or matching prefixes", async () => {
    const css = `/* url(../media/a.mov) */
.a { background: URL( '../media/a.mov#frame' ); content: "url(../media/a.mov)"; }
.b { background-image: url(../media/a\\.mov); }
.c { background-image: url(../media/a.mov.bak); }`;
    const root = await project({
      "styles/main.css": css,
      "index.html": '<style>.a { background: url(media/a.mov) }</style><div style="background:url(&quot;media/a.mov&quot;)"></div>',
    });
    const result = await planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a.mov", newPath: "media/b.mov" });
    expect(result.files.find(file => file.path === "styles/main.css")?.after).toBe(css
      .replace("URL( '../media/a.mov#frame' )", "URL( '../media/b.mov#frame' )")
      .replace("url(../media/a\\.mov)", 'url("../media/b.mov")'));
    expect(result.files.find(file => file.path === "index.html")?.after).toBe('<style>.a { background: url("media/b.mov") }</style><div style="background:url(&quot;media/b.mov&quot;)"></div>');
  });

  it("recognizes image srcset candidates and media source/poster references", async () => {
    const source = '<picture><source srcset="media/a.mov 1x, media/a.mov.bak 2x"><img srcset="media/a.mov, other.mov"></picture><video poster="media/a.mov"><source src="media/a.mov"></video>';
    const root = await project({ "index.html": source });
    const result = await planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a.mov", newPath: "media/b.mov" });
    expect(result.files[0]?.after).toBe('<picture><source srcset="media/b.mov 1x, media/a.mov.bak 2x"><img srcset="media/b.mov, other.mov"></picture><video poster="media/b.mov"><source src="media/b.mov"></video>');
  });

  it("respects a composition base URL and ignores media resolved against a remote base", async () => {
    const root = await project({
      "compositions/local.html": '<base href="../"><video src="media/a.mov"></video><div style="background:url(media/a.mov)"></div>',
      "compositions/remote.html": '<base href="https://example.com/"><video src="media/a.mov"></video>',
    });
    const result = await planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a.mov", newPath: "media/b.mov" });
    expect(result.dependents).toEqual(["compositions/local.html"]);
    expect(result.files[0]?.after).toBe('<base href="../"><video src="media/b.mov"></video><div style="background:url(&quot;media/b.mov&quot;)"></div>');
  });

  it("reports dependencies for deletion without preparing any file changes", async () => {
    const root = await project({
      ".studio/project.json": JSON.stringify(nativeDocument()),
      "index.html": '<video src="media/a.mov"></video>',
      "scripts/loader.js": 'const source = "../media/a.mov";',
      "scripts/classic.js": 'const source = "media/a.mov";',
    });
    const result = await planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a.mov" });
    expect(result).toEqual({ files: [], dependents: [".studio/project.json", "index.html", "scripts/classic.js", "scripts/loader.js"] });
  });

  it("removes an unused native asset record on deletion without treating registration as usage", async () => {
    const document = nativeDocument();
    document.sequence.tracks[0].clips = [];
    const root = await project({ ".studio/project.json": JSON.stringify(document) });
    const result = await planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a.mov" });
    expect(result.dependents).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(JSON.parse(result.files[0].after!)).toEqual({ ...document, revision: 5, assets: [] });
    expect(result.files[0].expectedBefore).toBe(JSON.stringify(document));
    expect(await readFile(join(root, ".studio/project.json"), "utf8")).toBe(JSON.stringify(document));
  });

  it.each([
    '<script>player.src = "media/a.mov";</script>',
    '<video onclick="this.src = &quot;media/a.mov&quot;"></video>',
    '<video data-src="media/a.mov"></video>',
  ])("refuses to guess how an executable or unsupported media reference should change", async source => {
    const root = await project({ "index.html": source });
    await expect(planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a.mov", newPath: "media/b.mov" })).rejects.toThrow(/Cannot safely update media references in index.html/);
    expect((await planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a.mov" })).dependents).toEqual(["index.html"]);
  });

  it("does not treat comments, example text, arbitrary IDs, or external URLs as media dependencies", async () => {
    const source = '<!-- <video src="media/a.mov"> --><textarea><video src="media/a.mov"></textarea><div id="media/a.mov">media/a.mov</div><script>// "media/a.mov"\nconst label = "unrelated";</script><img src="https://example.com/media/a.mov">';
    const root = await project({ "index.html": source });
    expect(await planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a.mov", newPath: "media/b.mov" })).toEqual({ files: [], dependents: [] });
  });

  it("refuses malformed native project data before preparing legacy changes", async () => {
    const root = await project({ ".studio/project.json": "{broken", "index.html": '<video src="media/a.mov">' });
    await expect(planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a.mov", newPath: "media/b.mov" })).rejects.toThrow(/project document is invalid/);
  });

  it("does not scan symlinked content outside the project", async () => {
    const root = await project({ "index.html": '<video src="media/a.mov">' });
    const outside = await project({ "script.js": 'const source = "../media/a.mov";' });
    await symlink(outside, join(root, "linked"));
    const result = await planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a.mov", newPath: "media/b.mov" });
    expect(result.dependents).toEqual(["index.html"]);
    expect(await readFile(join(outside, "script.js"), "utf8")).toBe('const source = "../media/a.mov";');
  });

  it("refuses a linked native project directory instead of reading or rewriting an external document", async () => {
    const root = await project({ "index.html": '<video src="media/a.mov">' });
    const outside = await project({ "project.json": JSON.stringify(nativeDocument()) });
    await symlink(outside, join(root, ".studio"));
    await expect(planMediaReferences({ projectRoot: root, projectId: "demo", oldPath: "media/a.mov", newPath: "media/b.mov" })).rejects.toThrow(/cannot be a symbolic link/);
  });
});
