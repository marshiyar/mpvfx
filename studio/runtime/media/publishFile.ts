import { constants } from "node:fs";
import { copyFile, link, open } from "node:fs/promises";

/** Exclusive publication on both hard-link and ordinary removable filesystems. */
export async function publishFileExclusive(source: string, destination: string): Promise<void> {
  try { await link(source, destination); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code ?? "")) throw error;
    // COPYFILE_EXCL is essential: a collision is never an overwrite request.
    // Callers hold the project/library write queue until publication finishes.
    await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  }
  const file = await open(destination, "r");
  try { await file.sync(); } finally { await file.close(); }
}
