import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { parseNativeProjectDocument } from "./nativeProjectDocument";
import { resolveNativeDomBinding, stabilizeNativeDomBindings } from "./nativeDomBinding";

const clipId = "native-clip:camera";
const domId = "cs146-chapter-05b";
const hfId = "hf-3cbc152b-197f-4695-966b-c86677d28c35";

function project() {
  return parseNativeProjectDocument({
    schemaVersion: 1, id: "project:binding", revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [{ id: "asset:camera", kind: "video", name: "camera.mov", durationFrames: 300 }],
    sequence: { id: "sequence:main", name: "Main", tracks: [{
      id: "track:video", kind: "video", clips: [{
        id: clipId, assetId: "asset:camera", binding: { sourceFile: "index.html", domId, hfId },
        startFrame: 0, durationFrames: 120, sourceInFrame: 0, muted: false,
        effects: [], parameterTracks: [],
      }],
    }] },
  });
}

function source(markup: string) {
  const { document } = parseHTML(`<main data-composition-id="main">${markup}</main>`);
  const query = (selector: string) => [...document.querySelectorAll(selector)];
  return { document, query };
}

describe("native DOM binding stabilization", () => {
  it("persists a preview-only hf-id on the uniquely bound authored element", () => {
    const { document, query } = source(`<video id="${domId}"></video>`);
    const native = project();
    const newIdentity = vi.fn(() => "unneeded");

    expect(stabilizeNativeDomBindings(native, "index.html", query, newIdentity)).toBe(true);
    expect(document.querySelector("video")?.getAttribute("data-hf-id")).toBe(hfId);
    expect(resolveNativeDomBinding(query, native.sequence.tracks[0]!.clips[0]!.binding!))
      .toBe(document.querySelector("video"));
    expect(newIdentity).not.toHaveBeenCalled();
  });

  it("restores a missing DOM id only when the hf-id identifies an unclaimed element", () => {
    const { document, query } = source(`<video data-hf-id="${hfId}"></video>`);
    expect(stabilizeNativeDomBindings(project(), "index.html", query, () => "unneeded")).toBe(true);
    expect(document.querySelector("video")?.getAttribute("id")).toBe(domId);
  });

  it.each([
    [`<video id="${domId}"></video><video id="${domId}"></video>`, "duplicate DOM id"],
    [`<video id="${domId}"></video><video data-hf-id="${hfId}"></video>`, "conflicting peers"],
    [`<video id="${domId}" data-hf-id="new-hf"></video>`, "changed hf-id"],
    [`<video id="${domId}" data-studio-clip-id="another-clip"></video>`, "another canonical owner"],
    [`<video id="${domId}"></video><video data-studio-clip-id="${clipId}"></video>`, "competing canonical claim"],
  ])("rejects %s without partially changing markup (%s)", (markup) => {
    const { document, query } = source(markup);
    const before = document.toString();
    expect(() => stabilizeNativeDomBindings(project(), "index.html", query, () => "unneeded"))
      .toThrow(`Cannot resolve clip ${clipId} uniquely in index.html`);
    expect(document.toString()).toBe(before);
  });
});
