import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { launchCrosspost, resolveCrosspostRender } from "../crosspostCommands";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe("publishing export handoff", () => {
  it("accepts a video export but rejects traversal, directories, and escaping symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "mpvfx-publish-")); roots.push(root);
    const renders = join(root, "renders"); await mkdir(renders);
    await writeFile(join(renders, "my video.mp4"), "video");
    await writeFile(join(root, "private.mp4"), "private");
    await mkdir(join(renders, "directory.mp4"));
    await symlink(join(root, "private.mp4"), join(renders, "escape.mp4"));
    await expect(resolveCrosspostRender(renders, "my video.mp4")).resolves.toContain("my video.mp4");
    for (const filename of ["../private.mp4", "escape.mp4", "directory.mp4", "script.py", "missing.mp4"]) {
      await expect(resolveCrosspostRender(renders, filename)).rejects.toThrow();
    }
  });
  it("waits for GUI readiness and reports a Python startup exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "mpvfx-publisher-start-")); roots.push(root);
    const source = join(root, "Crosspost");
    const data = join(root, "data");
    await mkdir(source);
    await writeFile(join(source, "gui.py"), "# fixture");
    const python = join(root, "python");
    await writeFile(python, `#!/usr/bin/env python3
import sys, time
if '-c' in sys.argv:
    sys.exit(0)
if '--ready-file' in sys.argv:
    with open(sys.argv[sys.argv.index('--ready-file') + 1], 'x') as marker:
        marker.write('ready')
    time.sleep(0.5)
`);
    await chmod(python, 0o755);
    const previous = process.env.MPVFX_CROSSPOST_PYTHON;
    process.env.MPVFX_CROSSPOST_PYTHON = python;
    try {
      await expect(launchCrosspost(source, data, join(root, "export.mp4"))).resolves.toBeUndefined();
      await writeFile(python, `#!/usr/bin/env python3
import sys
sys.exit(0 if '-c' in sys.argv else 7)
`);
      await expect(launchCrosspost(source, data, join(root, "export.mp4"))).rejects.toThrow("before its window opened");
    } finally {
      if (previous === undefined) delete process.env.MPVFX_CROSSPOST_PYTHON;
      else process.env.MPVFX_CROSSPOST_PYTHON = previous;
    }
  });
});
