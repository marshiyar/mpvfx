import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

interface ResolvedCompositionProject {
  id: string;
  dir: string;
}

interface DeleteStandaloneCompositionRequest {
  method?: string;
  pathname: string;
  body?: Uint8Array;
  resolveProject: (
    projectId: string,
  ) => Promise<ResolvedCompositionProject | null> | ResolvedCompositionProject | null;
  versionOf: (content: string) => string;
  now?: () => number;
}

const DELETE_ROUTE =
  /^\/projects\/([^/]+)\/file-mutations\/delete-composition\/([^/]+)$/;
const COMPOSITION_ROOT = /<[^>]+\bdata-composition-id\s*=\s*(?:"[^"]+"|'[^']+')[^>]*>/i;
const COMPOSITION_REFERENCE =
  /<[^>]+\bdata-composition-src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))[^>]*>/gi;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function decodeRoutePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isWithin(parentDir: string, childPath: string): boolean {
  const childRelativePath = relative(resolve(parentDir), resolve(childPath));
  return (
    childRelativePath !== "" &&
    !childRelativePath.startsWith(`..${sep}`) &&
    childRelativePath !== ".." &&
    !isAbsolute(childRelativePath)
  );
}

function validateRelativeHtmlPath(path: string): string | null {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /^[a-z]+:/i.test(path)
  ) {
    return null;
  }
  const normalized = normalize(path);
  if (
    normalized !== path ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    extname(normalized).toLowerCase() !== ".html"
  ) {
    return null;
  }
  return normalized;
}

function isSafeProjectId(projectId: string): boolean {
  if (
    !projectId ||
    projectId.includes("\0") ||
    projectId.includes("\\") ||
    isAbsolute(projectId) ||
    /^[a-z]+:/i.test(projectId)
  ) {
    return false;
  }
  const normalized = normalize(projectId);
  return (
    normalized === projectId &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith(`..${sep}`)
  );
}

function walkCompositionFiles(projectDir: string): string[] {
  const result: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".hyperframes" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".html") result.push(path);
    }
  };
  walk(projectDir);
  return result;
}

function referencedCompositionPaths(ownerPath: string, html: string): string[] {
  const paths: string[] = [];
  COMPOSITION_REFERENCE.lastIndex = 0;
  for (let match = COMPOSITION_REFERENCE.exec(html); match; match = COMPOSITION_REFERENCE.exec(html)) {
    const source = match[1] ?? match[2] ?? match[3];
    if (source) paths.push(resolve(dirname(ownerPath), source));
  }
  return paths;
}

function findDependents(projectDir: string, targetPath: string): string[] {
  const targetCanonical = realpathSync(targetPath);
  const dependents: string[] = [];
  for (const ownerPath of walkCompositionFiles(projectDir)) {
    if (realpathSync(ownerPath) === targetCanonical) continue;
    const html = readFileSync(ownerPath, "utf8");
    const referencesTarget = referencedCompositionPaths(ownerPath, html).some((candidate) => {
      if (!existsSync(candidate)) return false;
      try {
        return realpathSync(candidate) === targetCanonical;
      } catch {
        return false;
      }
    });
    if (referencesTarget) {
      dependents.push(relative(projectDir, ownerPath).split(sep).join("/"));
    }
  }
  return dependents.sort();
}

function masterCompositionPath(project: ResolvedCompositionProject): string | null {
  const projectDir = realpathSync(project.dir);
  for (const candidate of [join(projectDir, "index.html"), join(projectDir, `${project.id}.html`)]) {
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) continue;
    const canonical = realpathSync(candidate);
    if (!isWithin(projectDir, canonical)) continue;
    if (!COMPOSITION_ROOT.test(readFileSync(canonical, "utf8"))) continue;
    return canonical;
  }
  return null;
}

function ensureSafeArchiveDirectory(projectDir: string, directory: string): void {
  const relativeDirectory = relative(projectDir, directory);
  if (
    !relativeDirectory ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${sep}`) ||
    isAbsolute(relativeDirectory)
  ) {
    throw new Error("Archive directory escapes the project");
  }

  let current = projectDir;
  for (const segment of relativeDirectory.split(sep)) {
    current = join(current, segment);
    try {
      mkdirSync(current);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Archive directory is not a real project directory");
    }
    if (!isWithin(projectDir, realpathSync(current))) {
      throw new Error("Archive directory escapes the project");
    }
  }
}

function archiveComposition(
  projectDir: string,
  relativePath: string,
  sourcePath: string,
  timestamp: number,
): string {
  const archiveRoot = join(projectDir, ".hyperframes", "deleted-scenes");
  let attempt = 0;
  let archivePath = join(archiveRoot, String(timestamp), relativePath);
  while (existsSync(archivePath)) {
    attempt += 1;
    archivePath = join(archiveRoot, `${timestamp}-${attempt}`, relativePath);
  }
  ensureSafeArchiveDirectory(projectDir, dirname(archivePath));
  // The move is the backup and the deletion in one same-filesystem operation:
  // a failed archive never leaves the source missing.
  renameSync(sourcePath, archivePath);
  return relative(projectDir, archivePath).split(sep).join("/");
}

/**
 * Handles only the standalone Studio's protected reusable-scene deletion route.
 * Returning null delegates unrelated requests to the shared Studio API.
 */
export async function deleteStandaloneCompositionResponse(
  input: DeleteStandaloneCompositionRequest,
): Promise<Response | null> {
  if (input.method !== "POST") return null;
  const match = DELETE_ROUTE.exec(input.pathname);
  if (!match) return null;

  const projectId = decodeRoutePart(match[1] ?? "");
  const requestedPath = decodeRoutePart(match[2] ?? "");
  if (!projectId || requestedPath == null) return json(400, { error: "Invalid deletion path" });
  if (!isSafeProjectId(projectId)) {
    return json(403, { error: "Project id is outside the configured namespace" });
  }

  const relativePath = validateRelativeHtmlPath(requestedPath);
  if (!relativePath) return json(403, { error: "Scene path is outside the project" });

  let requestBody: unknown;
  try {
    requestBody = JSON.parse(Buffer.from(input.body ?? []).toString("utf8"));
  } catch {
    return json(400, { error: "A valid expectedVersion is required" });
  }
  const expectedVersion =
    requestBody && typeof requestBody === "object"
      ? Reflect.get(requestBody, "expectedVersion")
      : null;
  if (typeof expectedVersion !== "string" || !expectedVersion) {
    return json(400, { error: "A valid expectedVersion is required" });
  }

  const project = await input.resolveProject(projectId);
  if (!project) return json(404, { error: "Project not found" });

  const projectDir = realpathSync(project.dir);
  const requestedAbsolutePath = resolve(projectDir, relativePath);
  if (!isWithin(projectDir, requestedAbsolutePath)) {
    return json(403, { error: "Scene path is outside the project" });
  }
  if (!existsSync(requestedAbsolutePath)) return json(404, { error: "Scene not found" });

  const stat = lstatSync(requestedAbsolutePath);
  if (!stat.isFile()) return json(400, { error: "Scene must be an HTML file" });
  const sourcePath = realpathSync(requestedAbsolutePath);
  if (!isWithin(projectDir, sourcePath)) {
    return json(403, { error: "Scene path is outside the project" });
  }

  const masterPath = masterCompositionPath({ ...project, dir: projectDir });
  if (!masterPath) {
    return json(409, { error: "Project main timeline could not be identified" });
  }
  if (masterPath === sourcePath) {
    return json(403, { error: "The main timeline cannot be deleted" });
  }

  const source = readFileSync(sourcePath, "utf8");
  if (!COMPOSITION_ROOT.test(source)) return json(400, { error: "File is not a composition" });

  const currentVersion = input.versionOf(source);
  if (currentVersion !== expectedVersion) {
    return json(409, {
      error: "Scene changed before deletion",
      currentVersion,
    });
  }

  const dependents = findDependents(projectDir, sourcePath);
  if (dependents.length > 0) {
    return json(409, {
      error: "Scene is still used by another composition",
      dependents,
    });
  }

  try {
    const backupPath = archiveComposition(
      projectDir,
      relativePath,
      sourcePath,
      input.now?.() ?? Date.now(),
    );
    return json(200, { ok: true, path: relativePath, backupPath });
  } catch {
    return json(500, { error: "Could not archive the scene; nothing was deleted" });
  }
}
