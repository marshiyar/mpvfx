import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { decodePng } from "@hyperframes/engine/alpha-blit";

const require = createRequire(import.meta.url);
const policy = () => require("../scripts/apply-streaming-png-patch.cjs");

// A generated two-pixel PNG with RGB and transparency; no external media.
function pngFixture() {
  const chunk = (kind: string, bytes: Buffer) => {
    const data = Buffer.alloc(bytes.length + 12);
    data.writeUInt32BE(bytes.length); data.write(kind, 4); bytes.copy(data, 8);
    return data;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 64]))), chunk("IEND", Buffer.alloc(0))]);
}

describe("lossless PNG capture on Linux without FFmpeg PNG support", () => {
  it("changes only the PNG input transport, preserving frame rate, alpha, and encoder settings", () => {
    const args = ["-f", "image2pipe", "-vcodec", "png", "-framerate", "30000/1001", "-i", "-", "-r", "30000/1001", "-c:v", "prores_ks", "-pix_fmt", "yuva444p10le", "-y", "output.mov"];
    const tail = args.slice(args.indexOf("-i"));
    policy().rawPngInputArgs(args, { width: 2, height: 1 });
    expect(args).toEqual(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", "2x1", "-framerate", "30000/1001", ...tail]);
    expect([...policy().decodeCapturedPng(pngFixture(), { width: 2, height: 1 }, decodePng)]).toEqual([255, 0, 0, 255, 0, 0, 255, 64]);
    expect(() => policy().decodeCapturedPng(pngFixture(), { width: 3, height: 1 }, decodePng)).toThrow(/dimensions/i);
  });

  it("keeps JPEG captures, existing raw HDR input, and other platforms on their current paths", () => {
    const { needsRawPngInput } = policy();
    expect(needsRawPngInput({ imageFormat: "png" }, "linux")).toBe(true);
    expect(needsRawPngInput({ imageFormat: "jpeg" }, "linux")).toBe(false);
    expect(needsRawPngInput({ imageFormat: "png", rawInputFormat: "rgb48le" }, "linux")).toBe(false);
    expect(needsRawPngInput({ imageFormat: "png" }, "darwin")).toBe(false);
    expect(needsRawPngInput({ imageFormat: "png" }, "win32")).toBe(false);
  });

  it("guards every installed encoder and rejects unsupported upstream changes", () => {
    const { patchStreamingPngSource, assertStreamingPngPolicy } = policy();
    expect(() => assertStreamingPngPolicy(resolve(import.meta.dirname, ".."))).not.toThrow();
    for (const path of ["@hyperframes/engine/dist/services/streamingEncoder.js", ...["index.js", "public-server.js", "distributed.js"].map((file) => `@hyperframes/producer/dist/${file}`)]) {
      const source = readFileSync(resolve(import.meta.dirname, "../node_modules", path), "utf8");
      expect(patchStreamingPngSource(source, path)).toBe(source);
    }
    expect(() => patchStreamingPngSource("unsupported dependency", "test")).toThrow(/unsupported/i);
  });
});
