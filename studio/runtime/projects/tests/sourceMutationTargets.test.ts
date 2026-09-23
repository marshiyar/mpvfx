import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStudioApi, type StudioApiAdapter } from "@hyperframes/studio-server";
import { removeElementFromHtml } from "@hyperframes/studio-server/source-mutation";
import type { DesktopRequest } from "../../../shared/desktopBridge";
import { createStudioSaveHttpError, StudioFileConflictError } from "../../../src/features/history/studioSaveDiagnostics";

const roots: string[] = [];
const source = '<!DOCTYPE html><html><head></head><body><div data-composition-id="root" data-duration="10"><video id="main" data-hf-id="main-hf"></video><video id="split-first" class="duplicate" data-hf-id="shared"></video><video id="split-second" class="duplicate" data-hf-id="shared"></video><video id="split-third" class="duplicate" data-hf-id="shared"></video><video id="unrelated" data-hf-id="other"></video></div></body></html>';
const operations = [{ type: "inline-style", property: "opacity", value: "0.5" }];
const bbox = { left: 0, top: 0, width: 100, height: 100 };
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(html = source) {
  const dir = await mkdtemp(join(tmpdir(), "mutation-targets-"));
  roots.push(dir);
  await writeFile(join(dir, "index.html"), html);
  const api = createStudioApi({
    resolveProject: async () => ({ id: "demo", dir }),
    bundle: async () => null,
    runtimeUrl: "/api/runtime.js",
  } as unknown as StudioApiAdapter);
  const request = (operation: string, body: unknown) => api.fetch(new Request(
    `mpvfx://editor/projects/demo/file-mutations/${operation}/index.html`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  ));
  const saved = () => readFile(join(dir, "index.html"), "utf8");
  return { request, saved, api };
}

describe("legacy source mutation target identity", () => {
  it("groups the requested split, not the first clip sharing its stable identifier", async () => {
    const { request, saved } = await setup();
    const target = { hfId: "shared", id: "split-second", selector: "#split-second" };
    const response = await request("wrap-elements", {
      targets: [{ hfId: "main-hf", id: "main" }, target],
      groupId: "Chosen clips", bbox,
      rebases: [{ target, left: 12, top: 34 }],
    });
    expect(response.status).toBe(200);
    const document = parseHTML(await saved()).document;
    const group = document.querySelector("[data-hf-group]")!;
    expect(Array.from(group.children, (element) => element.id)).toEqual(["main", "split-second"]);
    expect(document.getElementById("split-second")?.getAttribute("style")).toContain("left: 12px");
    expect(document.getElementById("split-first")?.parentElement).not.toBe(group);
  });

  it.each([
    { hfId: "shared", id: "split-second" },
    { hfId: "shared", selector: "#split-second" },
    { hfId: "shared", id: "unrelated", selector: "#split-second" },
  ])("uses an independently unique candidate for %j", async (target) => {
    const { request, saved } = await setup();
    expect((await request("patch-element", { target, operations })).status).toBe(200);
    const document = parseHTML(await saved()).document;
    expect(document.getElementById("split-second")?.getAttribute("style")).toBe("opacity: 0.5");
    expect(document.getElementById("split-first")?.hasAttribute("style")).toBe(false);
    expect(document.getElementById("unrelated")?.hasAttribute("style")).toBe(false);
  });

  it.each([
    { hfId: "shared" },
    { hfId: "shared", id: "unrelated", selector: "#unrelated" },
    { hfId: "shared", selector: ".duplicate", selectorIndex: 1 },
    { hfId: "shared", selector: "[" },
  ])("rejects unresolved ambiguity without writing for %j", async (target) => {
    const { request, saved } = await setup();
    const response = await request("patch-element", { target, operations });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/Ambiguous element.*shared/) });
    expect(await saved()).toBe(source);
  });

  it.each(["targets", "rebases"])("rejects a whole group with ambiguous %s", async (field) => {
    const { request, saved } = await setup();
    const response = await request("wrap-elements", {
      targets: [{ hfId: "main-hf" }, { hfId: "shared", ...(field === "rebases" ? { id: "split-second" } : {}) }],
      groupId: "No partial group", bbox,
      rebases: field === "rebases" ? [{ target: { hfId: "shared" }, left: 12, top: 34 }] : [],
    });
    expect(response.status).toBe(422);
    expect(await saved()).toBe(source);
  });

  it("rejects a whole delete batch after an earlier valid target", async () => {
    const { request, saved } = await setup();
    expect((await request("remove-elements", {
      targets: [{ hfId: "main-hf" }, { hfId: "shared" }],
    })).status).toBe(422);
    expect(await saved()).toBe(source);
  });

  it("rejects a whole patch batch after an earlier valid target", async () => {
    const { request, saved } = await setup();
    expect((await request("patch-elements-batch", {
      patches: [{ target: { hfId: "main-hf" }, operations }, { target: { hfId: "shared" }, operations }],
    })).status).toBe(422);
    expect(await saved()).toBe(source);
  });

  it("does not treat duplicated DOM ids as independent identity", async () => {
    const html = source.replace('id="split-first"', 'id="split-second"');
    const { request, saved } = await setup(html);
    expect((await request("patch-element", {
      target: { hfId: "shared", id: "split-second", selector: "#split-second" }, operations,
    })).status).toBe(422);
    expect(await saved()).toBe(html);
  });

  it("retains the ambiguity message through the desktop response and save-error reader", async () => {
    const { api, saved } = await setup();
    vi.stubGlobal("window", {
      mpvfx: {
        request: async (input: DesktopRequest) => {
          const response = await api.fetch(new Request(`mpvfx://editor${input.path.replace(/^\/api/, "")}`, {
            method: input.method, headers: input.headers, body: input.body,
          }));
          return {
            status: response.status, statusText: response.statusText,
            headers: Array.from(response.headers.entries()), body: await response.arrayBuffer(),
          };
        },
        cancel: vi.fn(),
      },
    });
    const { desktopRequest } = await vi.importActual<typeof import("../../../src/lib/desktopClient")>("../../../src/lib/desktopClient");
    const response = await desktopRequest("/api/projects/demo/file-mutations/wrap-elements/index.html", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: [{ hfId: "main-hf" }, { hfId: "shared" }], groupId: "No partial group", bbox }),
    });
    const body = await response.clone().json();
    expect(body.error).toMatch(/Ambiguous element "shared"/);
    const error = await createStudioSaveHttpError(response, "Failed to group elements");
    expect(error.statusCode).toBe(422);
    expect(error).not.toBeInstanceOf(StudioFileConflictError);
    expect(error.message).toContain("Ambiguous element");
    expect(error.message).not.toMatch(/Save conflict|external/i);
    expect(await saved()).toBe(source);
  });

  it("provides the same explanation to client-side mutation callers", () => {
    expect(() => removeElementFromHtml(source, { hfId: "shared" })).toThrow(/Ambiguous element "shared"/);
  });

  it.each([
    [{ hfId: "main-hf", id: "unrelated", selector: "#unrelated" }, "main"],
    [{ hfId: "missing", id: "split-second" }, "split-second"],
    [{ selector: ".duplicate", selectorIndex: 1 }, "split-second"],
  ] as const)("preserves existing unambiguous resolution for %j", async (target, expectedId) => {
    const { request, saved } = await setup();
    expect((await request("patch-element", { target, operations })).status).toBe(200);
    const document = parseHTML(await saved()).document;
    expect(document.querySelector("[style]")?.id).toBe(expectedId);
  });
});
