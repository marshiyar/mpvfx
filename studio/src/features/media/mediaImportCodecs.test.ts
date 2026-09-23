import { describe, expect, it } from "vitest";
import {
  BROWSER_HOSTILE_CODECS,
  decideMediaProxyEligibility,
  probeAssetCodec,
  proxyVariantFor,
  resolveProxyVariantRequest,
} from "@hyperframes/studio-server/media-codec-map";

const facts = (codecName: string, browserHostile: boolean, hasAlpha = false) => ({
  codecName,
  browserHostile,
  representativeMime: null,
  hasAlpha,
});

describe("imported video codec preview policy", () => {
  it("covers every codec that requires a browser-safe preview proxy", () => {
    expect(BROWSER_HOSTILE_CODECS).toEqual({
      hevc: 'video/mp4; codecs="hvc1.1.6.L120.B0"',
      prores: null,
      av1: 'video/mp4; codecs="av01.0.08M.08"',
      vp9: 'video/webm; codecs="vp09.00.10.08"',
    });
  });

  it.each(["hevc", "prores", "av1", "vp9"])(
    "routes imported %s video through a proxy when direct playback is unsafe",
    (codec) => {
      expect(decideMediaProxyEligibility(facts(codec, true))).toEqual({ eligible: true });
    },
  );

  it.each(["h264", "vp8"])("keeps browser-safe %s imports on their original media", (codec) => {
    expect(decideMediaProxyEligibility(facts(codec, false))).toEqual({
      eligible: false,
      reason: "browser_safe_codec",
    });
  });

  it("does not guess when an imported file has no readable video codec", () => {
    expect(decideMediaProxyEligibility(null)).toEqual({
      eligible: false,
      reason: "unknown_codec",
    });
  });

  it("uses H.264/MP4 for opaque sources and VP8/WebM for alpha sources", () => {
    const opaque = facts("prores", true, false);
    const alpha = facts("prores", true, true);
    expect(proxyVariantFor(opaque)).toBe("h264");
    expect(proxyVariantFor(alpha)).toBe("vp8");
    expect(resolveProxyVariantRequest("auto", opaque)).toBe("h264");
    expect(resolveProxyVariantRequest("auto", alpha)).toBe("vp8");
  });

  it("refuses a requested proxy variant that would discard alpha", () => {
    expect(resolveProxyVariantRequest("h264", facts("prores", true, true))).toBeNull();
  });

  it.each([
    ["h264", false],
    ["vp8", false],
    ["hevc", true],
    ["prores", true],
    ["av1", true],
    ["vp9", true],
  ] as const)("maps ffprobe codec %s to browserHostile=%s", async (codecName, browserHostile) => {
    const result = await probeAssetCodec("/project/clip.mp4", async () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        streams: [{ codec_type: "video", codec_name: codecName, pix_fmt: "yuv420p" }],
      }),
    }));

    expect(result).toMatchObject({ codecName, browserHostile, hasAlpha: false });
  });

  it.each(["yuva420p", "rgba", "argb", "bgra", "abgr", "gbrap10le", "ya8"])(
    "preserves alpha reported as %s through the VP8 proxy strategy",
    async (pixelFormat) => {
      const result = await probeAssetCodec("/project/clip.mov", async () => ({
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", codec_name: "prores", pix_fmt: pixelFormat }],
        }),
      }));
      expect(result?.hasAlpha).toBe(true);
      expect(result && proxyVariantFor(result)).toBe("vp8");
    },
  );

  it("ignores an attached cover image and probes the real video stream", async () => {
    const result = await probeAssetCodec("/project/clip.mkv", async () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "mjpeg",
            pix_fmt: "yuvj420p",
            disposition: { attached_pic: 1 },
          },
          { codec_type: "video", codec_name: "hevc", pix_fmt: "yuv420p" },
        ],
      }),
    }));
    expect(result).toMatchObject({ codecName: "hevc", browserHostile: true });
  });

  it.each([
    ["nonzero ffprobe exit", { status: 1, stdout: "", stderr: "bad" }],
    ["invalid ffprobe JSON", { status: 0, stdout: "not json", stderr: "" }],
    ["missing ffprobe", { status: null, stdout: "", stderr: "", error: { code: "ENOENT" } }],
    [
      "an audio-only stream",
      {
        status: 0,
        stdout: JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "aac" }] }),
        stderr: "",
      },
    ],
  ] as const)("returns no codec facts for %s", async (_label, probeResult) => {
    await expect(probeAssetCodec("/project/clip.mp4", async () => probeResult)).resolves.toBeNull();
  });

  it.each(["mp4", "m4v", "mov", "webm"])(
    "probes imported .%s video containers",
    async (extension) => {
      let called = false;
      const result = await probeAssetCodec(`/project/clip.${extension}`, async () => {
        called = true;
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" }],
          }),
        };
      });
      expect(called).toBe(true);
      expect(result?.codecName).toBe("h264");
    },
  );
});
