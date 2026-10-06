import { describe, expect, it } from "vitest";
import { decodePng, encodePng } from "./png-rgba.mjs";

// Independently generated 2x1 RGB PNG: one red pixel followed by one blue pixel.
const sample = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGP4zwAE/wEHAAH/4iOeWQAAAABJRU5ErkJggg==",
  "base64",
);
const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]);

describe("packaged screenshot PNG codec", () => {
  it("reads known RGB screenshots and writes equivalent RGBA evidence", () => {
    const decoded = decodePng(sample);
    expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 2, height: 1 });
    expect(decoded.rgba).toEqual(pixels);
    expect(decodePng(encodePng(2, 1, pixels)).rgba).toEqual(pixels);
  });

  it("rejects corrupted screenshots before comparison", () => {
    const corrupt = Buffer.from(sample);
    corrupt[50] ^= 1;
    expect(() => decodePng(corrupt)).toThrow(/checksum/);
  });
});
