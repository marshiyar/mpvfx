import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { SUPPORTED_MEDIA_IMPORT_EXTENSIONS } from "../../shared/media/mediaImportPolicy";
import { binaryFileVersion, resolveMovePath, validateMovePath } from "./fileMoves";
import type { DurableFileTransactionReceipt } from "./fileTransaction";
import type { DurableFileTransactionHttpController } from "./fileTransactionHttp";
import { MediaReferencePlanningError, planMediaReferences } from "./mediaReferences";

interface MediaFileOperationRequest {
  method?: string;
  pathname: string;
  body?: string | Uint8Array;
  resolveProject: (projectId: string) => { id?: string; dir: string } | null | Promise<{ id?: string; dir: string } | null>;
  transactions: DurableFileTransactionHttpController;
}

const MEDIA_EXTENSIONS = new Set<string>(Object.values(SUPPORTED_MEDIA_IMPORT_EXTENSIONS).flat());
const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROTECTED_ROOTS = new Set([".hyperframes", ".studio", ".git", "node_modules", ".build"]);

class OperationFailure extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function decodeSegment(raw: string, project = false): string {
  let result: string;
  try { result = decodeURIComponent(raw); }
  catch { throw new OperationFailure(400, "Malformed file operation path"); }
  if (project && (!result || /[/\\\x00-\x1f\x7f]/.test(result) || result === "." || result === "..")) {
    throw new OperationFailure(403, "Invalid project identifier");
  }
  return result;
}

function validatePublicPath(path: unknown): string {
  if (typeof path !== "string") throw new OperationFailure(400, "A project-relative file path is required");
  try { validateMovePath(path); }
  catch { throw new OperationFailure(403, "File path is outside the project"); }
  if (PROTECTED_ROOTS.has(path.split("/")[0])) {
    throw new OperationFailure(403, "Project metadata cannot be renamed or deleted through the file browser");
  }
  return path;
}

function parseBody(body: string | Uint8Array | undefined): Record<string, unknown> {
  if (body === undefined || body.length === 0) return {};
  try {
    const value = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch { throw new OperationFailure(400, "File operation body must be a JSON object"); }
}

function success(receipt: DurableFileTransactionReceipt, path: string, deleted: boolean): Response {
  return json(200, {
    ok: true,
    ...(deleted ? { backupPath: path } : { path, updatedReferences: receipt.files.length }),
    receipt,
  });
}

/**
 * Media locations and their owned references are one durable edit. The caller
 * holds the same project access queue used by reads, saves, and notifications.
 */
export async function mediaFileOperationResponse(input: MediaFileOperationRequest): Promise<Response | null> {
  const method = input.method?.toUpperCase();
  if (method !== "PATCH" && method !== "DELETE") return null;
  const match = /^\/projects\/([^/]+)\/files\/(.+)$/.exec(input.pathname);
  if (!match) return null;
  try {
    const projectId = decodeSegment(match[1], true);
    const source = validatePublicPath(decodeSegment(match[2]));
    const project = await input.resolveProject(projectId);
    if (!project) return json(404, { error: "Project not found" });
    const root = await realpath(project.dir);
    let sourceEntry;
    try { sourceEntry = await lstat(join(root, source)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (sourceEntry?.isSymbolicLink()) return json(403, { error: "Symbolic links cannot be renamed or deleted through the file browser" });
    if (sourceEntry?.isDirectory()) {
      // Verify every directory component before allowing upstream handling of
      // an empty directory. Nonempty trees need their own explicit operation.
      await resolveMovePath(root, `${source}/.mpvfx-file-operation-check`);
      if ((await readdir(join(root, source))).length > 0) {
        return json(409, { error: "Rename or delete files individually; a nonempty folder may contain project dependencies" });
      }
      return null;
    }
    if (!MEDIA_EXTENSIONS.has(posix.extname(source).slice(1).toLowerCase())) return null;
    await resolveMovePath(root, source);
    const body = parseBody(input.body);
    const id = body.transactionId ?? randomUUID();
    if (typeof id !== "string" || !TRANSACTION_ID.test(id)) return json(400, { error: "Invalid media transaction identifier" });
    const deleted = method === "DELETE";
    const destination = deleted
      ? `.hyperframes/deleted-media/${id}/${posix.basename(source)}`
      : validatePublicPath(body.newPath);
    if (!deleted && source === destination) return json(200, { ok: true, path: source, updatedReferences: 0 });
    if (!deleted && posix.extname(source).toLowerCase() !== posix.extname(destination).toLowerCase()) {
      return json(400, { error: "Keep the media file extension when renaming; changing its name does not convert its format" });
    }
    const transactionPrefix = `/projects/${encodeURIComponent(projectId)}/file-transactions`;
    const priorResponse = await input.transactions.handle({ method: "GET", pathname: `${transactionPrefix}/${encodeURIComponent(id)}` });
    if (!priorResponse) throw new Error("Transaction service did not handle media status");
    if (priorResponse.ok) {
      const prior = await priorResponse.json() as DurableFileTransactionReceipt;
      const moves = prior.moves;
      if (moves?.length !== 1 || moves[0].from !== source || moves[0].to !== destination) {
        return json(409, { error: "This transaction identifier belongs to a different file operation" });
      }
      if (prior.state === "COMMITTED") return success(prior, destination, deleted);
      return json(409, { error: "The previous file operation did not commit; retry with a new transaction identifier" });
    }
    if (priorResponse.status !== 404) return priorResponse;
    const version = await binaryFileVersion(root, source);
    if (version === null) return json(404, { error: "Media file not found" });
    if (await binaryFileVersion(root, destination) !== null) return json(409, { error: "A file already exists at the requested destination" });
    const plan = await planMediaReferences({ projectRoot: root, projectId, oldPath: source, ...(deleted ? {} : { newPath: destination }) });
    if (deleted && plan.dependents.length) {
      return json(409, { error: "This media file is still used by the project", dependents: plan.dependents });
    }
    const commit = await input.transactions.handle({
      method: "POST",
      pathname: `${transactionPrefix}/commit`,
      body: JSON.stringify({
        id,
        files: plan.files,
        moves: [{ from: source, to: destination, expectedVersion: version }],
        history: { label: `${deleted ? "Delete" : "Rename"} media ${posix.basename(source)}`, kind: "manual" },
        ...(body.writeTokens === undefined ? {} : { writeTokens: body.writeTokens }),
      }),
    });
    if (!commit) throw new Error("Transaction service did not handle media commit");
    if (!commit.ok) return commit;
    const receipt = await commit.json() as DurableFileTransactionReceipt;
    if (receipt.state !== "COMMITTED") throw new Error("Media transaction did not commit");
    return success(receipt, destination, deleted);
  } catch (error) {
    if (error instanceof OperationFailure) return json(error.status, { error: error.message });
    if (error instanceof MediaReferencePlanningError) return json(409, { error: error.message });
    const message = error instanceof Error ? error.message : "File operation failed";
    if (/Unsafe|Reserved/.test(message)) return json(403, { error: message });
    if (/changed before commit/.test(message)) return json(409, { error: "Media changed before the operation could commit" });
    return json(500, { error: "Could not complete the media file operation" });
  }
}
