import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryService } from "../libraryService";
import { publishFileExclusive } from "../../media/publishFile";

const flush = vi.hoisted(() => ({ fileModes: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if ((String(args[0]).includes("Library.json.") && String(args[0]).endsWith(".tmp")) ||
          String(args[0]).endsWith("published.bin")) {
        flush.fileModes.push(String(args[1]));
        if (args[1] === "r") {
          Object.defineProperty(handle, "sync", {
            value: async () => { throw Object.assign(new Error("Windows read-only flush"), { code: "EPERM" }); },
          });
        }
      }
      return handle;
    },
  };
});

const modulePath = fileURLToPath(new URL("../../../.build/native/library/mpvfx_library.node", import.meta.url));
const roots: string[] = [];
const services: LibraryService[] = [];
afterEach(async () => {
  flush.fileModes.length = 0;
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("flushes a new library manifest through a write-capable file handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpvfx-library-flush-"));
  roots.push(root);
  const service = new LibraryService(join(root, "settings"), modulePath);
  services.push(service);
  const library = join(root, "Film.mpvfxlibrary");
  const libraryId = await service.create(library);
  expect(JSON.parse(await readFile(join(library, "Library.json"), "utf8")).id).toBe(libraryId);
  expect(flush.fileModes).toEqual(["r+"]);
});

it("flushes published media through a write-capable file handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "mpvfx-media-flush-"));
  roots.push(root);
  const source = join(root, "source.bin");
  const destination = join(root, "published.bin");
  await writeFile(source, Buffer.from([0, 7, 255]));
  await publishFileExclusive(source, destination);
  expect(await readFile(destination)).toEqual(Buffer.from([0, 7, 255]));
  expect(flush.fileModes).toEqual(["r+"]);
});
