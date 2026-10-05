import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LibraryService } from "./libraryService";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
// Allow framing overhead for one maximum-size file, while capping the entire
// multipart request rather than treating every member as a separate budget.
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 1024 * 1024;

/** Synthetic clipboard/browser files join the same catalog as native disk imports. */
export async function importLibraryUpload(
  request: Request,
  projectId: string,
  service: LibraryService,
  maxRequestBytes = MAX_REQUEST_BYTES,
): Promise<Response> {
  const tooLarge = () => Response.json(
    { error: "Generated upload exceeds 64 MiB; save it to disk and import it as a local file" },
    { status: 413 },
  );
  if (Number(request.headers.get("content-length")) > maxRequestBytes)
    return tooLarge();
  if (!request.body) return Response.json({ error: "A multipart upload is required" }, { status: 400 });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  let exceeded = false;
  // Drain an oversized source after dropping its chunks. Aborting an Undici
  // multipart stream mid-chunk can surface an unhandled enqueue rejection.
  for (;;) {
    request.signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maxRequestBytes) exceeded = true;
    if (!exceeded) chunks.push(value);
  }
  if (exceeded) return tooLarge();
  const limitedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const headers = new Headers(request.headers);
  // The input header may be absent or inaccurate; parsing uses counted bytes.
  headers.delete("content-length");
  const form = await new Request(request.url, {
    method: "POST", headers, body: limitedBody, duplex: "half", signal: request.signal,
  } as RequestInit & { duplex: "half" }).formData();
  const root = await mkdtemp(join(tmpdir(), "mpvfx-library-upload-"));
  try {
    const paths: string[] = [];
    for (const value of form.values()) {
      if (typeof value === "string") continue;
      if (value.size > MAX_FILE_BYTES) return tooLarge();
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
