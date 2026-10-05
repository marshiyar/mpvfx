import { resolveMovePath } from "../projects/fileMoves";
import { publishFileExclusive } from "../media/publishFile";
import { parseNativeProjectDocument } from "../../shared/project/nativeProjectDocument";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  open,
  mkdir,
  readFile,
  writeFile,
  realpath,
  stat,
  lstat,
  readdir,
  rename,
  rm,
  access,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { LibraryAsset, LibraryView } from "../../shared/library/library";
import type { LocalMediaImportResult } from "../../shared/desktopBridge";
import { importLocalMedia } from "../media/localImport";
import { classifyImportedVideoContainerCodec, probeImportedVideo } from "../media/importCodecs";
import { inspectMediaImportFile } from "../../shared/media/mediaImportPolicy";
import { createStandaloneCompositionSource } from "../projects/standaloneProject";
import { createProjectAccessQueue } from "../projects/projectAccess";

interface Asset extends LibraryAsset {
  source: string;
  fingerprint: string;
}
interface Catalog extends Omit<LibraryView, "path" | "assets"> {
  assets: Asset[];
  placements: { projectId: string; assetId: string; path: string }[];
  jobs: (LibraryView["jobs"][number] & { snapshot: string })[];
}
interface OpenLibrary {
  root: string;
  catalog: Catalog;
  lock: unknown;
}
interface NativeCatalog {
  lock(path: string): unknown;
  unlock(lock: unknown): void;
  command(path: string, action: string, args: string[]): Promise<string>;
}
const idPattern = /^[a-f0-9-]{36}$/;
function id(value: string): string {
  if (!idPattern.test(value)) throw new Error("Invalid library identity");
  return value;
}
function title(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("Enter a name (1–200 characters)");
  return value.trim();
}
function within(root: string, value: string): string {
  const path = resolve(root, value),
    offset = relative(root, path);
  if (
    !offset ||
    isAbsolute(offset) ||
    offset === ".." ||
    offset.startsWith(`..${sep}`)
  )
    throw new Error("Path escapes library storage");
  return path;
}
async function fingerprint(path: string): Promise<string> {
  const before = await stat(path);
  if (!before.isFile()) throw new Error("Media is not a regular file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await stat(path);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino
  )
    throw new Error("Source changed during import");
  return hash.digest("hex");
}
async function syncPath(path: string) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } catch (error) {
    if (!(await file.stat()).isDirectory() || !["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await file.close();
  }
}
async function publishText(path: string, content: string) {
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, content, { flag: "wx" });
    await syncPath(staged);
    await publishFileExclusive(staged, path);
    await syncPath(dirname(path));
  } finally {
    await rm(staged, { force: true });
  }
}
async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx" });
  await syncPath(temporary);
  await rename(temporary, path);
  await syncPath(dirname(path));
}
/** Native catalog owns identity. Project-relative views retain existing editor compatibility. */
export class LibraryService {
  private readonly libraries = new Map<string, OpenLibrary>();
  private readonly queue = createProjectAccessQueue();
  private readonly native: NativeCatalog;
  private readonly jobs = new Set<Promise<void>>();
  private readonly recent = new Set<string>();
  constructor(
    private readonly userData: string,
    modulePath: string,
  ) {
    this.native = createRequire(import.meta.url)(modulePath) as NativeCatalog;
  }
  private async command(
    library: OpenLibrary,
    action: string,
    args: string[] = [],
  ) {
    library.catalog = JSON.parse(
      await this.native.command(
        join(library.root, "Catalog.sqlite"),
        action,
        args,
      ),
    ) as Catalog;
    return library.catalog;
  }
  private get(libraryId: string) {
    const library = this.libraries.get(libraryId);
    if (!library) throw new Error("Library is not open");
    return library;
  }
  private async remember() {
    await mkdir(this.userData, { recursive: true });
    await atomicJson(join(this.userData, "libraries.json"), [...this.recent]);
  }
  async restore() {
    let paths: string[];
    try {
      paths = JSON.parse(
        await readFile(join(this.userData, "libraries.json"), "utf8"),
      );
    } catch {
      return;
    }
    if (!Array.isArray(paths)) return;
    for (const path of paths) {
      if (typeof path !== "string") continue;
      this.recent.add(path);
      try {
        await this.open(path, false);
      } catch (error) {
        console.warn("[Library] Could not reopen", path, error);
      }
    }
  }
  async create(path: string) {
    await mkdir(resolve(path));
    const root = await realpath(path); // Exclusive: never adopt or overwrite an existing directory.
    const libraryId = randomUUID();
    const catalog = JSON.parse(
      await this.native.command(join(root, "Catalog.sqlite"), "create", [
        libraryId,
        title(basename(root).replace(/\.mpvfxlibrary$/i, "")),
      ]),
    ) as Catalog;
    const library = {
      root,
      catalog,
      lock: this.native.lock(join(root, ".mpvfx-lock")),
    };
    await atomicJson(join(root, "Library.json"), {
      format: "mpvfx-library",
      version: 1,
      id: libraryId,
    });
    for (const directory of [
      "Projects",
      "Media/Originals",
      "Staging",
      "Snapshots",
      "renders",
    ])
      await mkdir(join(root, directory), { recursive: true });
    this.libraries.set(libraryId, library);
    await this.command(library, "event", [randomUUID(), "Media"]);
    this.recent.add(root);
    await this.remember();
    return libraryId;
  }
  async open(path: string, remember = true) {
    const root = await realpath(path);
    const manifest = JSON.parse(
      await readFile(join(root, "Library.json"), "utf8"),
    );
    if (manifest.format !== "mpvfx-library" || manifest.version !== 1)
      throw new Error("Unsupported library format");
    const libraryId = id(manifest.id);
    const existing = this.libraries.get(libraryId);
    if (existing) {
      if (existing.root !== root)
        throw new Error(
          "A copy of this library is already open. Close the application before opening the other copy.",
        );
      return libraryId;
    }
    for (const directory of [
      "Projects",
      "Media",
      "Media/Originals",
      "Staging",
      "Snapshots",
      "renders",
    ]) {
      if ((await lstat(join(root, directory))).isSymbolicLink())
        throw new Error("Library storage must not be a symbolic link");
    }
    if ((await lstat(join(root, "Catalog.sqlite"))).isSymbolicLink())
      throw new Error("Catalog must be inside the library");
    const catalog = JSON.parse(
      await this.native.command(join(root, "Catalog.sqlite"), "read", []),
    ) as Catalog;
    if (catalog.id !== libraryId)
      throw new Error("Library manifest and catalog do not match");
    // Validate all catalog-controlled directory components before mounting projects.
    for (const p of catalog.projects) {
      id(p.id);
      if (p.state === "ready") {
        if ((await lstat(join(root, "Projects", p.id))).isSymbolicLink())
          throw new Error("Project storage must not be a symbolic link");
        within(root, await realpath(join(root, "Projects", p.id)));
      }
    }
    for (const a of catalog.assets) {
      id(a.id);
      if (a.mode === "managed") within(root, a.source);
    }
    const library = {
      root,
      catalog,
      lock: this.native.lock(join(root, ".mpvfx-lock")),
    };
    this.libraries.set(libraryId, library);
    try {
      await this.command(library, "recover");
      for (const project of library.catalog.projects.filter(
        (p) => p.state === "pending",
      )) {
        try {
          await this.initializeProject(library, project.id);
        } catch (error) {
          console.warn(
            "[Library] Project creation remains incomplete",
            project.id,
            error,
          );
        }
      }
      for (const asset of library.catalog.assets.filter(
        (a) => a.state === "pending",
      )) {
        try {
          if (asset.mode === "managed") {
            const stage = join(root, "Staging", id(asset.id));
            const stagedFile = join(stage, basename(asset.source));
            try {
              if ((await fingerprint(stagedFile)) === asset.fingerprint) {
                await rename(stage, dirname(within(root, asset.source)));
                await syncPath(join(root, "Media/Originals"));
              }
            } catch {
              /* Already published, or staging incomplete. Verify final file below. */
            }
          }
          if (
            (await fingerprint(await this.assetSource(library, asset))) ===
            asset.fingerprint
          )
            await this.command(library, "assetReady", [asset.id]);
        } catch {
          /* Keep incomplete imports visibly pending; never expose partial files. */
        }
      }
      this.recent.add(root);
      if (remember) await this.remember();
    } catch (error) {
      this.native.unlock(library.lock);
      this.libraries.delete(libraryId);
      throw error;
    }
    return libraryId;
  }
  async views(): Promise<LibraryView[]> {
    return Promise.all(
      [...this.libraries.values()].map(async ({ root, catalog }) => ({
        id: catalog.id,
        name: catalog.name,
        path: root,
        events: catalog.events,
        projects: catalog.projects,
        jobs: catalog.jobs.map(({ snapshot: _snapshot, ...job }) => ({
          ...job,
          output: job.output ? within(root, job.output) : "",
        })),
        assets: await Promise.all(
          catalog.assets.map(
            async ({
              source: _source,
              fingerprint: _fingerprint,
              ...asset
            }) => {
              let available = false;
              try {
                await access(
                  await this.assetSource(
                    { root, catalog, lock: undefined },
                    catalog.assets.find((a) => a.id === asset.id)!,
                  ),
                );
                available = true;
              } catch {
                /* offline */
              }
              return { ...asset, available };
            },
          ),
        ),
      })),
    );
  }
  listProjects() {
    return [...this.libraries.values()].flatMap((l) =>
      l.catalog.projects
        .filter((p) => p.state === "ready")
        .map((p) => ({
          id: p.id,
          title: p.name,
          dir: join(l.root, "Projects", p.id),
        })),
    );
  }
  resolveProject(projectId: string) {
    return this.listProjects().find((p) => p.id === projectId) ?? null;
  }
  forProject(projectId: string) {
    return [...this.libraries.values()].find((l) =>
      l.catalog.projects.some((p) => p.id === projectId && p.state === "ready"),
    );
  }
  outputDirectory(projectId: string) {
    const l = this.forProject(projectId);
    return l ? join(l.root, "renders", id(projectId)) : null;
  }
  root(libraryId: string) {
    return this.get(libraryId).root;
  }
  async createEvent(libraryId: string, name: string) {
    const l = this.get(libraryId);
    await this.queue.run(l.root, () =>
      this.command(l, "event", [randomUUID(), title(name)]),
    );
  }
  private async initializeProject(l: OpenLibrary, projectId: string) {
    const root = join(l.root, "Projects", id(projectId));
    await mkdir(join(root, "vendor"), { recursive: true });
    const gsap = createRequire(import.meta.url).resolve(
      "gsap/dist/gsap.min.js",
    );
    await copyFile(
      gsap,
      join(root, "vendor/gsap.min.js"),
      constants.COPYFILE_FICLONE,
    );
    try {
      await publishText(
        join(root, "index.html"),
        createStandaloneCompositionSource(),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await mkdir(join(root, ".studio"), { recursive: true });
    const document = parseNativeProjectDocument({
      schemaVersion: 1,
      id: projectId,
      revision: 0,
      frameRate: { numerator: 30, denominator: 1 },
      canvas: { width: 1920, height: 1080, background: "#0a0a0b" },
      assets: [],
      sequence: {
        id: randomUUID(),
        name: l.catalog.projects.find((p) => p.id === projectId)!.name,
        durationFrames: 150,
        tracks: [],
      },
    });
    try {
      await publishText(
        join(root, ".studio/project.json"),
        JSON.stringify(document, null, 2),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = parseNativeProjectDocument(
      JSON.parse(await readFile(join(root, ".studio/project.json"), "utf8")),
    );
    if (existing.id !== projectId)
      throw new Error(
        "Incomplete project identity does not match its catalog entry",
      );
    for (const file of [
      "index.html",
      "vendor/gsap.min.js",
      ".studio/project.json",
      ".studio",
      "vendor",
      "",
    ])
      await syncPath(join(root, file));
    await this.command(l, "projectReady", [projectId]);
  }
  async createProject(libraryId: string, eventId: string, name: string) {
    const l = this.get(libraryId),
      projectId = randomUUID();
    await this.queue.run(l.root, async () => {
      await this.command(l, "project", [projectId, id(eventId), title(name)]);
      await this.initializeProject(l, projectId);
    });
    return projectId;
  }
  private async assetSource(l: OpenLibrary, asset: Asset) {
    if (asset.mode === "linked") return realpath(asset.source);
    const path = await realpath(within(l.root, asset.source));
    within(await realpath(join(l.root, "Media/Originals")), path);
    return path;
  }
  async import(
    libraryId: string,
    eventId: string,
    paths: string[],
    mode: "managed" | "linked",
    projectId?: string,
  ): Promise<LocalMediaImportResult> {
    const l = this.get(libraryId);
    return this.queue.run(l.root, async () => {
      if (!l.catalog.events.some((e) => e.id === eventId))
        throw new Error("Event not found");
      if (
        projectId &&
        !l.catalog.projects.some(
          (p) => p.id === projectId && p.state === "ready",
        )
      )
        throw new Error("Project is not in this library");
      const result: LocalMediaImportResult = { files: [], invalid: [] };
      for (const original of paths) {
        const assetId = randomUUID(),
          name = basename(original);
        try {
          const source = await realpath(original),
            info = await stat(source);
          const inspection = inspectMediaImportFile({
            name,
            size: info.size,
            type: "",
          });
          if (!inspection.accepted || !info.isFile())
            throw new Error("Unsupported or empty media file");
          const targetDir = join(l.root, "Media/Originals", assetId);
          const staging = join(l.root, "Staging", assetId);
          let staged: string | undefined;
          let hash: string;
          let stored: string;
          if (mode === "managed") {
            await mkdir(staging, { recursive: true });
            // Managed originals must be staged before catalog publication.
            const imported = await importLocalMedia({ projectRoot: staging, paths: [source] });
            if (imported.invalid.length || !imported.files[0])
              throw new Error(imported.invalid[0]?.reason ?? "Import failed");
            staged = join(staging, imported.files[0]);
            hash = await fingerprint(staged);
            stored = relative(l.root, join(targetDir, imported.files[0]));
          } else {
            // A linked original stays external. Validate its codec in place and
            // record its bytes without requiring a temporary full-size copy.
            if (inspection.kind === "video") {
              const facts = await probeImportedVideo(source);
              if (!facts || classifyImportedVideoContainerCodec(name, facts) === "unsupported")
                throw new Error("Unsupported video codec or container");
            }
            hash = await fingerprint(source);
            stored = source;
          }
          await this.command(l, "asset", [
            assetId,
            eventId,
            name,
            inspection.kind ?? "unknown",
            mode,
            stored,
            hash,
          ]);
          if (staged) {
            await syncPath(staged);
            await syncPath(staging);
            await rename(staging, targetDir);
            await syncPath(dirname(targetDir));
          }
          await this.command(l, "assetReady", [assetId]);
          if (projectId)
            result.files.push(await this.attachUnlocked(l, projectId, assetId));
          else result.files.push(assetId);
        } catch (error) {
          result.invalid.push({
            name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result;
    });
  }
  async importForProject(projectId: string, paths: string[]) {
    const l = this.forProject(projectId);
    if (!l) throw new Error("Library project not found");
    const project = l.catalog.projects.find((p) => p.id === projectId)!;
    return this.import(
      l.catalog.id,
      project.eventId,
      paths,
      "managed",
      projectId,
    );
  }
  private async attachUnlocked(
    l: OpenLibrary,
    projectId: string,
    assetId: string,
  ) {
    if (
      !l.catalog.projects.some((p) => p.id === projectId && p.state === "ready")
    )
      throw new Error("Project not found in library");
    const asset = l.catalog.assets.find(
      (a) => a.id === assetId && a.state === "ready",
    );
    if (!asset) throw new Error("Media is not ready");
    const source = await this.assetSource(l, asset);
    if ((await fingerprint(source)) !== asset.fingerprint)
      throw new Error(
        "Original media changed. Import it as a new asset to preserve existing edits.",
      );
    const path = `assets/${id(assetId)}/${basename(asset.name)}`;
    const destination = await resolveMovePath(
      l.root,
      `Projects/${id(projectId)}/${path}`,
      true,
    );
    const staging = join(dirname(destination), `.mpvfx-attach-${randomUUID()}`);
    try {
      await copyFile(
        source,
        staging,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      );
      if ((await fingerprint(staging)) !== asset.fingerprint)
        throw new Error("Source changed while attaching media");
      await syncPath(staging);
      try {
        await publishFileExclusive(staging, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await fingerprint(destination)) !== asset.fingerprint)
          throw new Error(
            "Project media has been modified; refusing to overwrite it",
          );
      }
      await syncPath(dirname(destination));
    } finally {
      await rm(staging, { force: true });
    }
    await this.command(l, "attach", [projectId, assetId, path]);
    return path;
  }
  async attach(libraryId: string, projectId: string, assetId: string) {
    const l = this.get(libraryId);
    return this.queue.run(l.root, () =>
      this.attachUnlocked(l, projectId, assetId),
    );
  }
  async relink(libraryId: string, assetId: string, path: string) {
    const l = this.get(libraryId);
    return this.queue.run(l.root, async () => {
      const asset = l.catalog.assets.find(
        (a) => a.id === assetId && a.mode === "linked",
      );
      if (!asset) throw new Error("Select linked media to relink");
      const source = await realpath(path);
      if ((await fingerprint(source)) !== asset.fingerprint)
        throw new Error(
          "This file is not the same media. Import replacement media separately.",
        );
      await this.command(l, "relink", [assetId, source]);
    });
  }
  /** Called while the runtime owns the project's edit lock. Copies isolate every renderer path. */
  async snapshot(projectId: string, settings: unknown = {}) {
    const l = this.forProject(projectId);
    if (!l) return null;
    return this.queue.run(l.root, async () => {
      const snapshotId = randomUUID(),
        root = join(l.root, "Snapshots", snapshotId),
        source = join(l.root, "Projects", projectId);
      const baseline = new Map<string, string>();
      const stamp = async (path: string) => {
        const s = await stat(path, { bigint: true });
        return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
      };
      const copyTree = async (from: string, to: string) => {
        await mkdir(to, { recursive: true });
        for (const entry of await readdir(from, { withFileTypes: true })) {
          if (
            ["renders", "node_modules", ".git", ".mpvfx-transactions"].includes(
              entry.name,
            ) ||
            entry.name.startsWith(".mpvfx-attach-")
          )
            continue;
          const input = join(from, entry.name),
            output = join(to, entry.name);
          if (entry.isSymbolicLink())
            throw new Error(`Cannot snapshot symbolic link: ${entry.name}`);
          if (entry.isDirectory()) await copyTree(input, output);
          else if (entry.isFile()) {
            baseline.set(input, await stamp(input));
            await copyFile(
              input,
              output,
              constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
            );
            await syncPath(output);
          }
        }
        await syncPath(to);
      };
      const verifyTree = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (
            ["renders", "node_modules", ".git", ".mpvfx-transactions"].includes(
              entry.name,
            ) ||
            entry.name.startsWith(".mpvfx-attach-")
          )
            continue;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await verifyTree(path);
          else if (
            !entry.isFile() ||
            baseline.get(path) !== (await stamp(path))
          )
            throw new Error(
              "Project changed during export snapshot; retry export",
            );
          else baseline.delete(path);
        }
      };
      try {
        await copyTree(source, root);
        await verifyTree(source);
        if (baseline.size)
          throw new Error(
            "Project files disappeared during export snapshot; retry export",
          );
        await mkdir(join(root, ".studio"), { recursive: true });
        let document: string | null = null;
        try {
          document = await readFile(join(root, ".studio/project.json"), "utf8");
        } catch {
          /* Legacy authored scene. */
        }
        await atomicJson(join(root, ".studio/export-snapshot.json"), {
          schemaVersion: 1,
          id: snapshotId,
          projectId,
          createdAt: new Date().toISOString(),
          settings,
          projectDocumentHash: document
            ? createHash("sha256").update(document).digest("hex")
            : null,
        });
        await this.command(l, "job", [
          snapshotId,
          projectId,
          relative(l.root, root),
        ]);
        return { id: snapshotId, dir: root, libraryId: l.catalog.id };
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
      }
    });
  }
  async failSnapshot(
    snapshot: { id: string; libraryId: string },
    error: string,
  ) {
    const l = this.get(snapshot.libraryId);
    await this.queue.run(l.root, () =>
      this.command(l, "jobFinish", [snapshot.id, "failed", "", error]),
    );
  }
  trackExport(
    snapshot: { id: string; libraryId: string },
    job: { status: string; outputPath?: string; error?: string },
    heartbeat?: () => void,
  ) {
    const done = (async () => {
      while (job.status === "rendering") {
        heartbeat?.();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const l = this.get(snapshot.libraryId);
      await this.queue.run(l.root, () =>
        this.command(l, "jobFinish", [
          snapshot.id,
          job.status,
          job.outputPath ? relative(l.root, job.outputPath) : "",
          job.error ?? "",
        ]),
      );
    })();
    this.jobs.add(done);
    void done
      .catch((error) =>
        console.error("[Library] Export status persistence failed", error),
      )
      .finally(() => this.jobs.delete(done));
  }
  async saveOutput(libraryId: string, jobId: string, destination: string, replaceApproved = false) {
    const l = this.get(libraryId),
      job = l.catalog.jobs.find(
        (j) => j.id === jobId && j.status === "complete",
      );
    if (!job) throw new Error("Completed export not found");
    const source = await realpath(within(l.root, job.output));
    within(await realpath(join(l.root, "renders")), source);
    const staged = join(dirname(destination), `.mpvfx-output-${randomUUID()}`);
    try {
      await copyFile(
        source,
        staged,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      );
      await syncPath(staged);
      if (replaceApproved) await rename(staged, destination);
      else await publishFileExclusive(staged, destination);
      await syncPath(dirname(destination));
    } finally {
      await rm(staged, { force: true });
    }
  }
  async close() {
    await Promise.allSettled([...this.jobs]);
    await this.queue.drain();
    for (const l of this.libraries.values()) this.native.unlock(l.lock);
    this.libraries.clear();
  }
}
