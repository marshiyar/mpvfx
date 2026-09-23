// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  deduplicateIds,
  serializeClipboardPayload,
  deserializeClipboardPayload,
  type ClipboardPayload,
} from "../clipboardPayload";

describe("deduplicateIds", () => {
  it("renames ids that collide with existing ids", () => {
    const html = '<div id="hero"><img id="photo" src="a.png" /></div>';
    const existingIds = ["hero", "other"];
    const result = deduplicateIds(html, existingIds);
    expect(result).not.toContain('id="hero"');
    expect(result).toContain('id="photo"');
    expect(result).toMatch(/id="hero-\d+"/);
  });

  it("returns html unchanged when no collisions", () => {
    const html = '<div id="unique"><p>hello</p></div>';
    const result = deduplicateIds(html, ["other"]);
    expect(result).toBe(html);
  });

  it("does not rewrite data-composition-id or other data-*-id attributes", () => {
    const html = '<div data-composition-id="hero" data-clip-id="hero" id="hero">content</div>';
    const result = deduplicateIds(html, ["hero"]);
    expect(result).toContain('data-composition-id="hero"');
    expect(result).toContain('data-clip-id="hero"');
    expect(result).toMatch(/\sid="hero-\d+"/);
  });

  it("gives a pasted subtree independent editor identities", () => {
    const html =
      '<div id="hero" data-hf-id="hf-original"><video data-hf-id="hf-child" src="media/clip.mp4" data-start="2"></video></div>';
    const result = deduplicateIds(html, ["hero"]);
    const identities = [...result.matchAll(/data-hf-id="([^"]+)"/g)].map((match) => match[1]);

    expect(identities).toHaveLength(2);
    expect(new Set(identities).size).toBe(2);
    expect(identities).not.toContain("hf-original");
    expect(identities).not.toContain("hf-child");
    expect(result).toContain('id="hero-2"');
    expect(result).toContain('src="media/clip.mp4" data-start="2"');
  });

  it("gives repeated pastes separate identities even when the source has duplicate identifiers", () => {
    const html = '<div data-hf-id="hf-shared"><span data-hf-id="hf-shared">Title</span></div>';
    const first = deduplicateIds(html, []);
    const second = deduplicateIds(html, []);
    const identities = [...(first + second).matchAll(/data-hf-id="([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(identities).toHaveLength(4);
    expect(new Set(identities).size).toBe(4);
    expect(identities).not.toContain("hf-shared");
  });
});

describe("serializeClipboardPayload / deserializeClipboardPayload", () => {
  it("round-trips a timeline clip payload", () => {
    const payload: ClipboardPayload = {
      kind: "timeline-clip",
      html: '<img id="photo" src="a.png" data-start="1" data-duration="3" />',
      sourceFile: "index.html",
    };
    const json = serializeClipboardPayload(payload);
    const parsed = deserializeClipboardPayload(json);
    expect(parsed).toEqual(payload);
  });

  it("round-trips a dom-element payload", () => {
    const payload: ClipboardPayload = {
      kind: "dom-element",
      html: '<div class="card"><p>Hello</p></div>',
      sourceFile: "compositions/scene.html",
    };
    const json = serializeClipboardPayload(payload);
    const parsed = deserializeClipboardPayload(json);
    expect(parsed).toEqual(payload);
  });

  it("returns null for invalid JSON", () => {
    expect(deserializeClipboardPayload("not json")).toBeNull();
    expect(deserializeClipboardPayload('{"kind":"unknown"}')).toBeNull();
  });
});
