import { constants } from "node:fs";
import { copyFile, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { publishFileExclusive } from "./publishFile";
import { basename, dirname, extname, join, posix } from "node:path";
import { inspectMediaImportFile } from "../../shared/media/mediaImportPolicy";
import type { LocalMediaImportResult } from "../../shared/desktopBridge";
import { resolveMovePath } from "../projects/fileMoves";
import { classifyImportedVideoContainerCodec, probeImportedVideo } from "./importCodecs";

/** OS-level copying keeps multi-gigabyte media out of renderer memory and IPC. */
export async function importLocalMedia(input: {
  projectRoot: string;
  paths: readonly string[];
  directory?: string;
}): Promise<LocalMediaImportResult> {
  const root = await realpath(input.projectRoot);
  const directory = input.directory || "";
  if (directory && (directory.split("/").some(part => part.startsWith(".")) ||
      ["node_modules", "renders"].includes(directory.split("/")[0]!))) throw new Error("Invalid import directory");
  const result: LocalMediaImportResult = { files: [], invalid: [] };
  for (const source of input.paths) {
    const name = basename(source);
    let staging: string | undefined;
    try {
      const info = await stat(source);
      const inspection = inspectMediaImportFile({ name, size: info.size, type: "" });
      if (!info.isFile() || !inspection.accepted) throw new Error("Unsupported or empty media file");
      const relative = directory ? posix.join(directory, name) : name;
      const destination = await resolveMovePath(root, relative, true);
      staging = await mkdtemp(join(dirname(destination), ".mpvfx-import-"));
      const staged = join(staging, name);
      await copyFile(source, staged, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const after = await stat(source);
      if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ino !== after.ino || info.dev !== after.dev)
        throw new Error("Source file changed during import; try again");
      if (inspection.kind === "video") {
        const facts = await probeImportedVideo(staged);
        if (!facts || classifyImportedVideoContainerCodec(name, facts) === "unsupported")
          throw new Error("Unsupported video codec or container");
      }
      // Publish under the project write queue before registering imported media.
      const extension = extname(name);
      for (let index = 0; ; index++) {
        const candidate = index === 0 ? relative : `${relative.slice(0, -extension.length)} (${index + 1})${extension}`;
        const target = await resolveMovePath(root, candidate, true);
        try {
          await publishFileExclusive(staged, target);
          result.files.push(candidate);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    } catch (error) {
      result.invalid.push({ name, reason: error instanceof Error ? error.message : "Import failed" });
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
  return result;
}
