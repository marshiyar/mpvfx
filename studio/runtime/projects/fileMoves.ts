import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ProjectFileMove } from "../../shared/desktopBridge";

const DIGEST_CACHE_LIMIT = 256;
const digestCache = new Map<string, string>();

function fileFingerprint(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

function cacheDigest(fingerprint: string, digest: string): void {
  digestCache.delete(fingerprint);
  digestCache.set(fingerprint, digest);
  if (digestCache.size > DIGEST_CACHE_LIMIT) digestCache.delete(digestCache.keys().next().value!);
}

export function validateMovePath(path: string): string {
  if (typeof path !== "string" || !path || isAbsolute(path) || /[\\\0-\x1f]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Unsafe media move path: a project-relative file path is required");
  }
  const parts = path.split("/");
  if (parts[0] === ".hyperframes" &&
      !(parts.length >= 4 && parts[1] === "deleted-media" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parts[2]))) {
    throw new Error("Reserved media move path");
  }
  return path;
}

async function entry(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally { await handle?.close(); }
}

/** Reject symlinked parents as well as files, including paths inside the archive. */
export async function resolveMovePath(root: string, path: string, createParents = false): Promise<string> {
  validateMovePath(path);
  const parts = path.split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    const next = join(parent, part);
    let info = await entry(next);
    if (!info && createParents) {
      try { await mkdir(next); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await syncDirectory(parent);
      info = await entry(next);
    }
    if (!info) return join(root, path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe media move parent: ${path}`);
    parent = next;
  }
  const target = join(root, path);
  const info = await entry(target);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`Unsafe media move target: ${path}`);
  return target;
}

/** Hash bytes incrementally: large videos are never loaded into a text journal. */
export async function binaryFileVersion(root: string, path: string): Promise<string | null> {
  const target = await resolveMovePath(root, path);
  let handle;
  try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`Unsafe media move target: ${path}`);
    const fingerprint = fileFingerprint(before);
    let digest = digestCache.get(fingerprint);
    if (digest === undefined) {
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      digest = hash.digest("hex");
    }
    const after = await handle.stat({ bigint: true });
    let current: BigIntStats | null;
    try { current = await lstat(target, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = null;
    }
    if (!current || !current.isFile() || current.isSymbolicLink() ||
        fileFingerprint(after) !== fingerprint || fileFingerprint(current) !== fingerprint) {
      throw new Error(`Media ${path} changed before commit`);
    }
    // A location/mtime alone is never identity. Even cache hits revalidate the
    // opened inode and the pathname, including ctime for same-size replacements.
    cacheDigest(fingerprint, digest);
    return digest;
  } finally { await handle.close(); }
}

export function normalizeFileMoves(moves: unknown): ProjectFileMove[] | undefined {
  if (moves === undefined) return undefined;
  if (!Array.isArray(moves)) throw new Error("Transaction moves must be an array");
  return moves.map((move) => {
    if (!move || typeof move.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(move.expectedVersion)) {
      throw new Error("Media move requires an exact SHA256 expectedVersion");
    }
    return { from: validateMovePath(move.from), to: validateMovePath(move.to), expectedVersion: move.expectedVersion };
  });
}

type MoveState = "before" | "linked" | "after";

export async function inspectFileMove(root: string, move: ProjectFileMove): Promise<MoveState> {
  const from = await binaryFileVersion(root, move.from);
  const to = await binaryFileVersion(root, move.to);
  if (from === move.expectedVersion && to === null) return "before";
  if (from === null && to === move.expectedVersion) return "after";
  if (from === move.expectedVersion && to === move.expectedVersion) {
    const [a, b] = await Promise.all([
      lstat(join(root, move.from), { bigint: true }),
      lstat(join(root, move.to), { bigint: true }),
    ]);
    if (a.ino === b.ino && a.dev === b.dev) return "linked";
  }
  throw new Error(`Media move ${move.from} → ${move.to} changed before commit or recovery`);
}

/** Exclusive destination creation avoids rename() silently replacing another file. */
export async function applyFileMove(
  root: string,
  move: ProjectFileMove,
  direction: "forward" | "rollback",
  afterLink?: () => void | Promise<void>,
): Promise<void> {
  const state = await inspectFileMove(root, move);
  if ((direction === "forward" && state === "after") || (direction === "rollback" && state === "before")) return;
  const source = direction === "forward" ? move.from : move.to;
  const destination = direction === "forward" ? move.to : move.from;
  const from = await resolveMovePath(root, source);
  const to = await resolveMovePath(root, destination, true);
  if (state !== "linked") {
    await link(from, to);
    await syncDirectory(dirname(to));
    await afterLink?.();
  }
  if (await inspectFileMove(root, move) !== "linked") throw new Error(`Media move ${source} changed before commit`);
  await unlink(from);
  await syncDirectory(dirname(from));
}
