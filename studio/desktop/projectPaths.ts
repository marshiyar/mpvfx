import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ensureStandaloneProject } from "../vite.standalone-project";

export interface DesktopDataPaths {
  root: string;
  projects: string;
  renders: string;
  cache: string;
  sessions: string;
}

/**
 * Electron chooses the platform-specific userData root. Everything mutable is
 * derived from it, so packaged application resources remain read-only.
 */
export function resolveDesktopDataPaths(
  userDataPath: string,
  _platform: NodeJS.Platform,
): DesktopDataPaths {
  const root = resolve(userDataPath);
  return {
    root,
    projects: resolve(root, "projects"),
    renders: resolve(root, "renders"),
    cache: resolve(root, "cache"),
    sessions: resolve(root, "sessions"),
  };
}

export function ensureDesktopProject(
  paths: DesktopDataPaths,
  options: { gsapSourcePath?: string } = {},
): ReturnType<typeof ensureStandaloneProject> {
  for (const directory of [paths.root, paths.projects, paths.renders, paths.cache, paths.sessions]) {
    mkdirSync(directory, { recursive: true });
  }
  return ensureStandaloneProject(paths.projects, options);
}
