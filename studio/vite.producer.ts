import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export function resolveInstalledProducerEntry(studioDir: string): string | null {
  const requireFromStudio = createRequire(resolve(studioDir, "package.json"));
  const searchPaths = requireFromStudio.resolve.paths("@hyperframes/producer") ?? [];

  for (const searchPath of searchPaths) {
    const packageJsonPath = resolve(searchPath, "@hyperframes/producer/package.json");
    if (!existsSync(packageJsonPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        exports?: { "."?: { import?: string } | string };
        module?: string;
        main?: string;
      };
      const rootExport = pkg.exports?.["."];
      const relativeEntry =
        (typeof rootExport === "object" ? rootExport.import : rootExport) ?? pkg.module ?? pkg.main;
      if (!relativeEntry) continue;
      const entry = resolve(dirname(packageJsonPath), relativeEntry);
      if (existsSync(entry)) return entry;
    } catch {
      continue;
    }
  }

  return null;
}

export function ensureProducerDist(opts: {
  studioDir: string;
  resolveInstalledProducerEntryImpl?: (studioDir: string) => string | null;
}): { producerDistEntry: string } {
  const resolveEntry = opts.resolveInstalledProducerEntryImpl ?? resolveInstalledProducerEntry;
  const producerDistEntry = resolveEntry(opts.studioDir);
  if (!producerDistEntry) {
    throw new Error(
      "@hyperframes/producer is not installed. Run npm install in the studio directory and restart the editor.",
    );
  }

  return { producerDistEntry };
}

export function createRetryingModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;

  return async () => {
    if (!promise) {
      promise = load().catch((error) => {
        promise = null;
        throw error;
      });
    }
    return promise;
  };
}
