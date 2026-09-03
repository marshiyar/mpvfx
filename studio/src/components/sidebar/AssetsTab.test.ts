import { describe, expect, it } from "vitest";
import { deriveUsedPaths } from "./AssetsTab";
import { truncateMiddle, formatDuration } from "./assetHelpers";

describe("deriveUsedPaths", () => {
  it("matches the asset-list format across every src shape", () => {
    const used = deriveUsedPaths([
      { src: "assets/logo.png" }, // raw authored relative path
      { src: "/api/projects/demo/preview/assets/bgm.mp3" }, // served form
      { src: "./assets/icon.svg" }, // ./-prefixed
      { src: "assets/clip.mp4?v=2" }, // cache-busted
      {}, // no src — skipped
    ]);
    expect(used.has("assets/logo.png")).toBe(true);
    expect(used.has("assets/bgm.mp3")).toBe(true);
    expect(used.has("assets/icon.svg")).toBe(true);
    expect(used.has("assets/clip.mp4")).toBe(true);
    expect(used.size).toBe(4);
  });

  it("an authored relative src lines up with the asset entry (the live bug class)", () => {
    const used = deriveUsedPaths([{ src: "assets/logo.png" }]);
    expect(used.has("assets/logo.png")).toBe(true);
    expect(used.has("assets/orphan.wav")).toBe(false);
  });

  it("handles fully-absolute URLs produced by the core runtime (toAbsoluteAssetUrl)", () => {
    // The runtime calls new URL(raw, document.baseURI).toString() which produces
    // "http://localhost:3012/api/projects/demo/preview/assets/clip.mp4"
    const used = deriveUsedPaths([
      { src: "http://localhost:3012/api/projects/demo/preview/assets/clip.mp4" },
      { src: "http://localhost:3012/api/projects/abc123/preview/assets/logo.png" },
    ]);
    expect(used.has("assets/clip.mp4")).toBe(true);
    expect(used.has("assets/logo.png")).toBe(true);
    expect(used.size).toBe(2);
  });

  it("decodes percent-encoded filenames (spaces, parens) so they match the asset list", () => {
    // Files with spaces/parens: "assets/my file (1).mp4" authored in HTML
    // → runtime resolves to "http://…/assets/my%20file%20(1).mp4"
    const used = deriveUsedPaths([
      { src: "http://localhost:3012/api/projects/p/preview/assets/my%20file%20(1).mp4" },
      { src: "/api/projects/p/preview/assets/track%20one.mp3" },
    ]);
    expect(used.has("assets/my file (1).mp4")).toBe(true);
    expect(used.has("assets/track one.mp3")).toBe(true);
    expect(used.size).toBe(2);
  });

  it("round-trips an absolute URL with spaces to the plain asset-list path", () => {
    const used = deriveUsedPaths([
      { src: "http://localhost:3012/api/projects/demo/preview/assets/my%20video.mp4" },
    ]);
    expect(used.has("assets/my video.mp4")).toBe(true);
    expect(used.has("assets/other.png")).toBe(false);
  });
});

describe("truncateMiddle", () => {
  it("returns the original string when it fits within maxLen", () => {
    expect(truncateMiddle("short.mp4", 20)).toBe("short.mp4");
    expect(truncateMiddle("exact_length_str.mp4", 20)).toBe("exact_length_str.mp4");
  });

  it("truncates longer strings with an ellipsis in the middle", () => {
    const result = truncateMiddle("2a37eabf-long-uuid-887d8.mp4", 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain("…");
    // Preserves head
    expect(result.startsWith("2a37eabf-long-uuid-8")).toBe(false); // head is shortened
    expect(result.startsWith("2a37eabf")).toBe(true);
    // Preserves tail
    expect(result.endsWith("887d8.mp4")).toBe(false); // tail portion only
    expect(result.endsWith(".mp4")).toBe(true);
  });

  it("preserves the full filename extension in the tail", () => {
    const result = truncateMiddle("verylongnamehere12345.mp4", 14);
    expect(result.endsWith(".mp4")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(14);
  });

  it("handles maxLen of 1 (degenerate)", () => {
    const result = truncateMiddle("abcdef", 1);
    // head = 0, tail = 0 → just the ellipsis
    expect(result).toBe("…");
  });

  it("handles a string of exactly maxLen+1 chars", () => {
    const result = truncateMiddle("abcdefgh", 7);
    expect(result.length).toBeLessThanOrEqual(7);
    expect(result).toContain("…");
  });
});

describe("formatDuration", () => {
  it("formats whole seconds as MM:SS", () => {
    expect(formatDuration(28)).toBe("00:28");
    expect(formatDuration(60)).toBe("01:00");
    expect(formatDuration(90)).toBe("01:30");
    expect(formatDuration(3661)).toBe("61:01");
  });

  it("rounds fractional seconds to nearest whole", () => {
    expect(formatDuration(28.4)).toBe("00:28");
    expect(formatDuration(28.6)).toBe("00:29");
  });

  it("returns empty string for non-positive values", () => {
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(-1)).toBe("");
  });

  it("returns empty string for non-finite values", () => {
    expect(formatDuration(NaN)).toBe("");
    expect(formatDuration(Infinity)).toBe("");
    expect(formatDuration(-Infinity)).toBe("");
  });
});
