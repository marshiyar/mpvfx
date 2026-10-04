import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LibraryService } from "./libraryService";

/** Synthetic clipboard/browser files join the same catalog as native disk imports. */
export async function importLibraryUpload(
  request: Request,
  projectId: string,
  service: LibraryService,
): Promise<Response> {
  if (Number(request.headers.get("content-length")) > 500 * 1024 * 1024)
    return Response.json(
      { error: "Use local file import for media above 500 MiB" },
      { status: 413 },
    );
  const form = await request.formData();
  const root = await mkdtemp(join(tmpdir(), "mpvfx-library-upload-"));
  try {
    const paths: string[] = [];
    for (const value of form.values()) {
      if (typeof value === "string") continue;
      if (value.size > 500 * 1024 * 1024)
        return Response.json(
          { error: "Use local file import for media above 500 MiB" },
          { status: 413 },
        );
      const dir = join(root, String(paths.length));
      await mkdir(dir);
      const path = join(dir, basename(value.name));
      await pipeline(
        Readable.fromWeb(
          value.stream() as import("node:stream/web").ReadableStream,
        ),
        createWriteStream(path, { flags: "wx" }),
      );
      paths.push(path);
    }
    return Response.json(await service.importForProject(projectId, paths));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
