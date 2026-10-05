import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewOriginForProject } from "../../../shared/desktopPreviewOrigin";
import { createStudioRuntime, type StudioRuntime } from "../../service";

let directory: string;
let runtime: StudioRuntime;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "preview-agent-delivery-"));
  const output = join(directory, ".build/runtime");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "preview-agent.js"), "/* isolated-preview-agent */");
  runtime = createStudioRuntime({
    projectsDir: directory,
    adapterHost: {
      studioDir: directory,
      loadModule: async () => { throw new Error("Unexpected project API load"); },
    },
    loadRuntimeSource: () => "/* core-preview-runtime */",
  });
});
afterAll(async () => {
  await runtime?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("preview agent runtime delivery", () => {
  it("prepends the agent only for a canonical project preview origin", async () => {
    const response = await runtime.handle(new Request(`${previewOriginForProject("scene")}/api/runtime.js`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("/* isolated-preview-agent */\n;/* core-preview-runtime */");
  });

  it.each([
    "mpvfx://editor/api/runtime.js",
    "mpvfx://bad.preview/api/runtime.js",
    "mpvfx://7363656e65.preview.evil/api/runtime.js",
    "http://localhost/api/runtime.js",
  ])("keeps agent out of editor, malformed, and thumbnail runtime %s", async url => {
    const response = await runtime.handle(new Request(url));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("/* core-preview-runtime */");
  });
});
