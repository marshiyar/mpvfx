import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  open,
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { LibraryService } from "../libraryService";
import { importLibraryUpload } from "../libraryUpload";

const modulePath = fileURLToPath(
  new URL("../../../.build/native/library/mpvfx_library.node", import.meta.url),
);
const native = createRequire(import.meta.url)(modulePath);
const roots: string[] = [];
const services: LibraryService[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
  "base64",
);
function service(root: string) {
  const value = new LibraryService(join(root, "settings"), modulePath);
  services.push(value);
  return value;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mpvfx-library-test-"));
  roots.push(root);
  const library = join(root, "Film.mpvfxlibrary"),
    engine = service(root),
    libraryId = await engine.create(library);
  const eventId = (await engine.views())[0]!.events[0]!.id;
  const first = await engine.createProject(libraryId, eventId, "Main Edit"),
    second = await engine.createProject(libraryId, eventId, "Short Version");
  const source = join(root, "Khé¿.png");
  await writeFile(source, png);
  return { root, library, engine, libraryId, eventId, first, second, source };
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

describe("native library workflow", () => {
  it("keeps other projects open when an incomplete project document cannot be recovered", async () => {
    const f = await fixture(),
      projectId = randomUUID();
    await native.command(join(f.library, "Catalog.sqlite"), "project", [
      projectId,
      f.eventId,
      "Incomplete",
    ]);
    const directory = join(f.library, "Projects", projectId, ".studio");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "project.json"), "partial document");
    await f.engine.close();
    const reopened = service(f.root);
    await reopened.open(f.library);
    expect(reopened.listProjects()).toHaveLength(2);
    expect(
      (await reopened.views())[0]!.projects.find((p) => p.id === projectId)!
        .state,
    ).toBe("pending");
    expect(await readFile(join(directory, "project.json"), "utf8")).toBe(
      "partial document",
    );
  });

  it("imports library media above 500 MiB through bounded filesystem IO", async () => {
    const f = await fixture(),
      source = join(f.root, "large.wav"),
      size = 501 * 1024 * 1024;
    const file = await open(source, "wx");
    const header = Buffer.alloc(44);
    header.write("RIFF");
    header.writeUInt32LE(size - 8, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(2, 22);
    header.writeUInt32LE(48000, 24);
    header.writeUInt32LE(192000, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(size - 44, 40);
    await file.truncate(size);
    await file.write(header, 0, header.length, 0);
    await file.close();
    const result = await f.engine.importForProject(f.first, [source]);
    expect(result.invalid).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(
      (
        await stat(
          join(f.engine.resolveProject(f.first)!.dir, result.files[0]!),
        )
      ).size,
    ).toBe(size);
    expect((await f.engine.views())[0]!.assets[0]!.mode).toBe("managed");
  }, 20000);

  it("shares one catalog asset across two independent project views and reopens their edits", async () => {
    const f = await fixture();
    const result = await f.engine.import(
      f.libraryId,
      f.eventId,
      [f.source],
      "managed",
    );
    expect(result.invalid).toEqual([]);
    const initial = JSON.parse(
      await readFile(
        join(f.engine.resolveProject(f.first)!.dir, ".studio/project.json"),
        "utf8",
      ),
    );
    expect(initial.id).toBe(f.first);
    expect(initial.sequence.tracks).toEqual([]);
    const assetId = result.files[0]!;
    const path = await f.engine.attach(f.libraryId, f.first, assetId);
    await f.engine.attach(f.libraryId, f.second, assetId);
    const first = f.engine.resolveProject(f.first)!.dir,
      second = f.engine.resolveProject(f.second)!.dir;
    await writeFile(join(first, "index.html"), "Main edit saved");
    await rm(join(first, path));
    expect(await readFile(join(second, path))).toEqual(png);
    expect(await readFile(f.source)).toEqual(png);
    expect((await f.engine.views())[0]!.assets).toHaveLength(1);
    await f.engine.close();
    const reopened = service(f.root);
    await reopened.restore();
    expect(reopened.listProjects().map((p) => p.title)).toEqual([
      "Main Edit",
      "Short Version",
    ]);
    expect(
      await readFile(
        join(reopened.resolveProject(f.first)!.dir, "index.html"),
        "utf8",
      ),
    ).toBe("Main edit saved");
    expect(await reopened.attach(f.libraryId, f.first, assetId)).toBe(path);
  });
  it("keeps identical filenames as distinct assets and reports per-file failures", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "other"));
    const other = join(f.root, "other", "Khé¿.png");
    await writeFile(other, Buffer.concat([png, Buffer.from("different")]));
    const result = await f.engine.import(
      f.libraryId,
      f.eventId,
      [f.source, join(f.root, "missing.png"), other],
      "managed",
      f.first,
    );
    expect(result.files).toHaveLength(2);
    expect(new Set(result.files).size).toBe(2);
    expect(result.invalid).toHaveLength(1);
    const project = f.engine.resolveProject(f.first)!.dir;
    expect(await readFile(join(project, result.files[0]!))).toEqual(png);
    expect(await readFile(join(project, result.files[1]!))).not.toEqual(png);
  });
  it("keeps linked originals external, detects offline media, and verifies relinking", async () => {
    const f = await fixture();
    const result = await f.engine.import(
      f.libraryId,
      f.eventId,
      [f.source],
      "linked",
    );
    const assetId = result.files[0]!;
    const path = await f.engine.attach(f.libraryId, f.first, assetId);
    const moved = join(f.root, "moved.png");
    await rename(f.source, moved);
    expect((await f.engine.views())[0]!.assets[0]!.available).toBe(false);
    await expect(
      f.engine.attach(f.libraryId, f.second, assetId),
    ).rejects.toThrow();
    const wrong = join(f.root, "wrong.png");
    await writeFile(wrong, "wrong");
    await expect(f.engine.relink(f.libraryId, assetId, wrong)).rejects.toThrow(
      "not the same media",
    );
    await f.engine.relink(f.libraryId, assetId, moved);
    expect((await f.engine.views())[0]!.assets[0]!.available).toBe(true);
    await f.engine.attach(f.libraryId, f.second, assetId);
    await rm(join(f.engine.resolveProject(f.first)!.dir, path));
    expect(await readFile(moved)).toEqual(png);
  });
  it("registers linked media without staging a duplicate", async () => {
    const f = await fixture();
    const staging = join(f.library, "Staging");
    await rm(staging, { recursive: true });
    await writeFile(staging, "staging unavailable");
    try {
      const result = await f.engine.import(f.libraryId, f.eventId, [f.source], "linked");
      expect(result.invalid).toEqual([]);
      expect(result.files).toHaveLength(1);
      expect((await f.engine.views())[0]!.assets[0]).toMatchObject({ mode: "linked", state: "ready" });
    } finally {
      await rm(staging);
      await mkdir(staging);
    }
  });
  it("keeps video codec validation when linking without staging", async () => {
    const f = await fixture();
    const invalidVideo = join(f.root, "invalid.mp4");
    await writeFile(invalidVideo, "not an MP4");
    const result = await f.engine.import(f.libraryId, f.eventId, [invalidVideo], "linked");
    expect(result.files).toEqual([]);
    expect(result.invalid[0]?.reason).toMatch(/codec|container/i);
    expect((await f.engine.views())[0]!.assets).toEqual([]);
  });
  it("opens a moved managed library without original sources or old app settings", async () => {
    const f = await fixture();
    const { files } = await f.engine.import(
      f.libraryId,
      f.eventId,
      [f.source],
      "managed",
    );
    await f.engine.close();
    await rm(f.source);
    const moved = join(f.root, "Renamed.mpvfxlibrary");
    await rename(f.library, moved);
    const fresh = service(join(f.root, "fresh"));
    await fresh.open(moved);
    const path = await fresh.attach(f.libraryId, f.first, files[0]!);
    expect(
      await readFile(join(fresh.resolveProject(f.first)!.dir, path)),
    ).toEqual(png);
  });
  it("rejects a second writer and releases the OS lock on close", async () => {
    const f = await fixture();
    const second = service(join(f.root, "second"));
    await expect(second.open(f.library)).rejects.toThrow("already open");
    await f.engine.close();
    expect(await second.open(f.library)).toBe(f.libraryId);
  });
  it("recovers a cataloged staged import and interrupted export after restart", async () => {
    const f = await fixture(),
      assetId = randomUUID();
    const stage = join(f.library, "Staging", assetId);
    await mkdir(stage);
    await writeFile(join(stage, "frame.png"), png);
    await native.command(join(f.library, "Catalog.sqlite"), "asset", [
      assetId,
      f.eventId,
      "frame.png",
      "image",
      "managed",
      `Media/Originals/${assetId}/frame.png`,
      createHash("sha256").update(png).digest("hex"),
    ]);
    const snapshot = await f.engine.snapshot(f.first);
    expect(snapshot).not.toBeNull();
    await f.engine.close();
    const reopened = service(f.root);
    await reopened.open(f.library);
    const view = (await reopened.views())[0]!;
    expect(view.assets[0]!.state).toBe("ready");
    expect(view.jobs[0]!.status).toBe("interrupted");
    expect(
      await readFile(join(f.library, "Media/Originals", assetId, "frame.png")),
    ).toEqual(png);
  });
  it("snapshots project files and media independently from subsequent modifications", async () => {
    const f = await fixture();
    const { files } = await f.engine.import(
      f.libraryId,
      f.eventId,
      [f.source],
      "managed",
      f.first,
    );
    const project = f.engine.resolveProject(f.first)!.dir,
      path = files[0]!;
    const original = await readFile(join(project, "index.html"));
    const snapshot = (await f.engine.snapshot(f.first))!;
    await writeFile(join(project, "index.html"), "new edit");
    await writeFile(join(project, path), "changed view");
    expect(await readFile(join(snapshot.dir, "index.html"))).toEqual(original);
    expect(await readFile(join(snapshot.dir, path))).toEqual(png);
    const asset = (await f.engine.views())[0]!.assets[0]!;
    const other = await f.engine.attach(f.libraryId, f.second, asset.id);
    expect(
      await readFile(join(f.engine.resolveProject(f.second)!.dir, other)),
    ).toEqual(png);
  });
  it("persists export completion and refuses to overwrite an existing destination", async () => {
    const f = await fixture();
    const snapshot = (await f.engine.snapshot(f.first))!;
    const output = join(f.engine.outputDirectory(f.first)!, "output.mp4");
    await mkdir(join(f.library, "renders", f.first), { recursive: true });
    await writeFile(output, "encoded-fixture");
    f.engine.trackExport(snapshot, { status: "complete", outputPath: output });
    await f.engine.close();
    const reopened = service(f.root);
    await reopened.open(f.library);
    expect((await reopened.views())[0]!.jobs[0]!.status).toBe("complete");
    const destination = join(f.root, "saved.mp4");
    await reopened.saveOutput(f.libraryId, snapshot.id, destination);
    expect(await readFile(destination, "utf8")).toBe("encoded-fixture");
    await writeFile(destination, "keep me");
    await expect(
      reopened.saveOutput(f.libraryId, snapshot.id, destination),
    ).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("keep me");
  });
  it("rejects project and asset identities from another library", async () => {
    const f = await fixture();
    const otherId = await f.engine.create(join(f.root, "Other.mpvfxlibrary"));
    const event = (await f.engine.views()).find((l) => l.id === otherId)!
      .events[0]!.id;
    const otherProject = await f.engine.createProject(otherId, event, "Other");
    const { files } = await f.engine.import(
      f.libraryId,
      f.eventId,
      [f.source],
      "managed",
    );
    await expect(
      f.engine.attach(f.libraryId, otherProject, files[0]!),
    ).rejects.toThrow("not found");
    await expect(
      f.engine.createProject(f.libraryId, event, "Wrong event"),
    ).rejects.toThrow();
  });
  it("routes synthetic clipboard uploads into the same catalog", async () => {
    const f = await fixture();
    const form = new FormData();
    form.append(
      "files",
      new File([new Uint8Array(png)], "clipboard.png", { type: "image/png" }),
    );
    const response = await importLibraryUpload(
      new Request("http://local/upload", { method: "POST", body: form }),
      f.first,
      f.engine,
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.invalid).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect((await f.engine.views())[0]!.assets[0]!.name).toBe("clipboard.png");
  });
  it.each(["missing", "understated"])("bounds multipart bytes when Content-Length is %s", async headerKind => {
    const f = await fixture();
    const single = new FormData();
    single.append("files", new File([png], "first.png", { type: "image/png" }));
    const oneRequest = new Request("http://local/upload", { method: "POST", body: single });
    const maxRequestBytes = (await oneRequest.arrayBuffer()).byteLength + 1;
    const form = new FormData();
    form.append("files", new File([png], "first.png", { type: "image/png" }));
    form.append("files", new File([png], "second.png", { type: "image/png" }));
    const source = new Request("http://local/upload", { method: "POST", body: form });
    const headers = new Headers(source.headers);
    if (headerKind === "missing") headers.delete("content-length");
    else headers.set("content-length", "1");
    const request = new Request(source.url, {
      method: "POST", headers, body: source.body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await importLibraryUpload(request, f.first, f.engine, maxRequestBytes);
    expect(response.status).toBe(413);
    expect((await f.engine.views())[0]!.assets).toEqual([]);
  });
  it("uses the 64 MiB generated upload ceiling with multipart framing allowance", async () => {
    const f = await fixture();
    const maxRequestBytes = 65 * 1024 * 1024;
    const form = new FormData();
    form.append("files", new File([png], "small.png", { type: "image/png" }));
    const source = new Request("http://local/upload", { method: "POST", body: form });
    const headers = new Headers(source.headers);
    headers.set("content-length", String(maxRequestBytes + 1));
    const oversized = new Request(source.url, {
      method: "POST", headers, body: source.body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect((await importLibraryUpload(oversized, f.first, f.engine)).status).toBe(413);
    expect((await f.engine.views())[0]!.assets).toEqual([]);

    const allowedForm = new FormData();
    allowedForm.append("files", new File([png], "small.png", { type: "image/png" }));
    const allowedSource = new Request("http://local/upload", { method: "POST", body: allowedForm });
    const allowedHeaders = new Headers(allowedSource.headers);
    allowedHeaders.set("content-length", String(maxRequestBytes));
    const allowed = new Request(allowedSource.url, {
      method: "POST", headers: allowedHeaders, body: allowedSource.body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect((await importLibraryUpload(allowed, f.first, f.engine)).status).toBe(200);
  });
  it("rejects symbolic links during export rather than capturing external mutable files", async () => {
    const f = await fixture();
    await symlink(
      f.source,
      join(f.engine.resolveProject(f.first)!.dir, "outside.png"),
    );
    await expect(f.engine.snapshot(f.first)).rejects.toThrow("symbolic link");
    expect((await f.engine.views())[0]!.jobs).toHaveLength(0);
  });
  it("does not overwrite an existing library or project storage", async () => {
    const f = await fixture();
    await expect(f.engine.create(f.library)).rejects.toThrow();
    expect(
      (await stat(join(f.library, "Catalog.sqlite"))).size,
    ).toBeGreaterThan(0);
    expect(f.engine.listProjects()).toHaveLength(2);
  });
});
