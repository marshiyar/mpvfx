import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioApi, type StudioApiAdapter } from "@hyperframes/studio-server";
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";

const roots: string[] = [];
const source = '<!DOCTYPE html><html><head></head><body><div data-composition-id="root" data-duration="5"><div class="shape" data-start="0" data-duration="5">Shape</div></div></body></html>';
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "readonly-preview-"));
  roots.push(dir);
  await mkdir(join(dir, "scenes"));
  await writeFile(join(dir, "index.html"), source);
  await writeFile(join(dir, "scenes/scene.html"), source);
  const api = createStudioApi({
    resolveProject: async () => ({ id: "demo", dir }),
    bundle: async () => null,
    runtimeUrl: "/api/runtime.js",
  } as unknown as StudioApiAdapter);
  const request = (path: string, init?: RequestInit) =>
    api.fetch(new Request(`mpvfx://editor/projects/demo/${path}`, init));
  return { dir, request };
}

describe("preview source ownership", () => {
  it("loads root and nested previews without modifying either source or invalidating a pending save", async () => {
    const { dir, request } = await setup();
    const baseline = await (await request("files/index.html")).json();
    for (const path of ["preview", "preview/comp/scenes/scene.html", "preview"]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("data-hf-id=");
    }
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe(source);
    expect(await readFile(join(dir, "scenes/scene.html"), "utf8")).toBe(source);
    const save = await request("files/index.html", {
      method: "PUT",
      headers: { "If-Match": baseline.version, "Content-Type": "text/plain" },
      body: source.replace("Shape", "Edited"),
    });
    expect(save.status).toBe(200);
  });

  it("persists generated element IDs only when an explicit edit uses them", async () => {
    const { dir, request } = await setup();
    const id = ensureHfIds(source).match(/data-hf-id="([^"]+)" class="shape"/)?.[1];
    expect(id).toBeTruthy();
    const edit = await request("file-mutations/patch-element/index.html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: { hfId: id }, operations: [
        { type: "inline-style", property: "opacity", value: "0.5" },
      ] }),
    });
    expect(edit.status).toBe(200);
    expect(await edit.json()).toMatchObject({ matched: true, changed: true });
    const saved = await readFile(join(dir, "index.html"), "utf8");
    expect(saved).toContain(`data-hf-id="${id}"`);
    expect(saved).toContain("opacity: 0.5");
  });
});
