import { describe, expect, it } from "vitest";
import { parseSourceDocument } from "../sourceDocument";

describe("inert source documents", () => {
  it("preserves full document attributes, metadata, and media source text", () => {
    const doc = parseSourceDocument('<!doctype html><html lang="en"><head><title>Scene</title></head><body data-composition-id="root"><video src="clip.mp4"></video></body></html>');
    expect(doc.documentElement.getAttribute("lang")).toBe("en");
    expect(doc.head.querySelector("title")?.textContent).toBe("Scene");
    expect(doc.body.getAttribute("data-composition-id")).toBe("root");
    expect(doc.body.querySelector("video")?.getAttribute("src")).toBe("clip.mp4");
    expect(doc.querySelector("video")).not.toHaveProperty("remote");
  });

  it("places all fragment siblings inside one comparison root", () => {
    const doc = parseSourceDocument('<video id="a"></video><audio id="b"></audio>tail');
    expect(doc.documentElement.localName).toBe("html");
    expect([...doc.body.children].map((element) => element.id)).toEqual(["a", "b"]);
    expect(doc.documentElement.outerHTML).toContain('<audio id="b"></audio>tail');
  });

  it("recognizes the parsed tree instead of shell words inside comments or scripts", () => {
    const script = 'const shell = "<html><body>";';
    const doc = parseSourceDocument(`<!-- <html> --><script>${script}</script><video id="a"></video>`);
    expect(doc.documentElement.localName).toBe("html");
    expect(doc.body.querySelector("script")?.textContent).toBe(script);
    expect(doc.body.querySelector("video")?.id).toBe("a");
  });

  it("preserves body-only composition attributes while adding the missing shell", () => {
    const doc = parseSourceDocument('<body data-composition-id="root" data-duration="9"><video id="a"></video></body>');
    expect(doc.body.getAttribute("data-composition-id")).toBe("root");
    expect(doc.body.getAttribute("data-duration")).toBe("9");
    expect(doc.body.querySelector("video")?.id).toBe("a");
    expect(doc.querySelectorAll("body")).toHaveLength(1);
  });

  it("preserves a doctype before a fragment and handles empty source", () => {
    const doc = parseSourceDocument('<!doctype html><video id="a"></video><audio id="b"></audio>');
    expect(doc.doctype?.name).toBe("html");
    expect(doc.body.children).toHaveLength(2);
    expect(parseSourceDocument("").documentElement.outerHTML).toBe("<html><head></head><body></body></html>");
  });

  it("keeps source siblings around a complete html root inside the comparison shell", () => {
    const doc = parseSourceDocument('<p id="before">first</p><html><body><video id="a"></video></body></html><p id="after">last</p>');
    expect([...doc.body.children].map((element) => element.id)).toEqual(["before", "a", "after"]);
    expect(doc.querySelectorAll("html")).toHaveLength(1);
  });
});
