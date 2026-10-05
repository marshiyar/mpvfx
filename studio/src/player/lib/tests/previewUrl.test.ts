import { describe, expect, it } from "vitest";
import { isExpectedPreviewMessage, resolvePreviewUrl } from "../previewUrl";

describe("isolated preview URL", () => {
  it("moves a desktop composition to its project host", () => {
    expect(
      resolvePreviewUrl(
        "project-a",
        "/api/projects/project-a/preview/comp/a.html?t=2",
        "mpvfx://editor",
      ),
    ).toBe(
      "mpvfx://70726f6a6563742d61.preview/api/projects/project-a/preview/comp/a.html?t=2",
    );
  });

  it("rejects unrelated desktop paths and external URLs", () => {
    expect(() =>
      resolvePreviewUrl(
        "project-a",
        "/api/projects/project-b/preview",
        "mpvfx://editor",
      ),
    ).toThrow();
    expect(() =>
      resolvePreviewUrl(
        "project-a",
        "https://example.com/preview",
        "mpvfx://editor",
      ),
    ).toThrow();
  });

  it("requires both the iframe source and project origin for messages", () => {
    const source = {} as Window;
    const iframe = {
      src: "mpvfx://70726f6a6563742d61.preview/api/projects/project-a/preview",
      contentWindow: source,
    } as HTMLIFrameElement;
    const event = {
      source,
      origin: "mpvfx://70726f6a6563742d61.preview",
    } as MessageEvent;
    expect(isExpectedPreviewMessage(event, iframe)).toBe(true);
    expect(
      isExpectedPreviewMessage(
        { ...event, source: {} } as MessageEvent,
        iframe,
      ),
    ).toBe(false);
    expect(
      isExpectedPreviewMessage(
        { ...event, origin: "mpvfx://editor" } as MessageEvent,
        iframe,
      ),
    ).toBe(false);
  });
});
