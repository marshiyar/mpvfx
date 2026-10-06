import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

/** A renderer can name an export, but cannot supply an arbitrary local path. */
export async function resolveCrosspostRender(root: string, filename: string): Promise<string> {
  if (typeof filename !== "string" || !/^[^/\\\x00-\x1f]+\.(mp4|mov|mkv|webm)$/i.test(filename)) {
    throw new Error("Select a completed video export");
  }
  const directory = await realpath(root);
  const file = await realpath(join(directory, filename));
  const offset = relative(directory, file);
  if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`) || !(await stat(file)).isFile()) {
    throw new Error("Export is outside its render directory");
  }
  return file;
}

/** Launch the contributor's GUI. Opening it never starts an upload. */
export async function launchCrosspost(sourceDir: string, userData: string, file: string): Promise<void> {
  if (!(await stat(join(sourceDir, "gui.py"))).isFile()) throw new Error("Publisher source is unavailable");
  const credentialsDir = join(userData, "publishing");
  await mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  const selectedPython = process.env.MPVFX_CROSSPOST_PYTHON?.trim() ||
    (await readFile(join(credentialsDir, "python-path.txt"), "utf8").catch(() => "")).trim();
  if (selectedPython && !isAbsolute(selectedPython)) {
    throw new Error(`Publisher Python path must be absolute. Check ${join(credentialsDir, "python-path.txt")}`);
  }
  const python = selectedPython || "python3";
  const env = { ...process.env, MPVFX_CROSSPOST_CONFIG_DIR: credentialsDir };
  // Diagnose missing dependencies before reporting that the publisher opened.
  await new Promise<void>((accept, reject) => {
    const check = spawn(python, ["-c", "import tkinter, customtkinter, requests, googleapiclient.discovery, google_auth_oauthlib.flow"], {
      shell: false, stdio: "ignore", env,
    });
    const timer = setTimeout(() => { check.kill(); reject(new Error("Publisher environment check timed out")); }, 10_000);
    check.once("error", () => { clearTimeout(timer); reject(new Error(`Publishing requires Python with Tk. Configure ${join(credentialsDir, "python-path.txt")} with its absolute path.`)); });
    check.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) accept();
      else reject(new Error(`Publishing requires the Crosspost Python dependencies and Tk. See ${join(sourceDir, "README.md")} and configure ${join(credentialsDir, "python-path.txt")}.`));
    });
  });
  const startupDir = await mkdtemp(join(tmpdir(), "mpvfx-publisher-start-"));
  const readyFile = join(startupDir, "ready");
  try {
    await new Promise<void>((accept, reject) => {
      const child = spawn(python, [join(sourceDir, "gui.py"), "--video", file, "--ready-file", readyFile], {
        cwd: credentialsDir, env, shell: false, detached: true, stdio: "ignore",
      });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        if (error) reject(error);
        else { child.unref(); accept(); }
      };
      const poll = setInterval(() => {
        if (child.exitCode !== null) {
          finish(new Error(`Publisher exited before its window opened (code ${child.exitCode}). Check Python and Tk setup.`));
          return;
        }
        void stat(readyFile).then(() => finish(), () => undefined);
      }, 100);
      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error("Publisher window did not open within 10 seconds. Check Python and Tk setup."));
      }, 10_000);
      child.once("error", () => finish(new Error("Could not start the configured Publisher Python executable.")));
      child.once("exit", code => finish(new Error(`Publisher exited before its window opened (code ${code}). Check Python and Tk setup.`)));
    });
  } finally {
    await rm(startupDir, { recursive: true, force: true });
  }
}
