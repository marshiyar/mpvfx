import { describe, expect, it, vi } from "vitest";
import {
  acceptStudioRuntimeMessage,
  acceptedRuntimeMessageFrameRate,
  acceptedRuntimeMessageFps,
  createRuntimeControlMessage,
  inspectStudioRuntimeMessage,
  postRuntimeControlMessage,
} from "./runtimeProtocol";

describe("Studio runtime protocol", () => {
  it("versions every control message and declares rational fps", () => {
    expect(createRuntimeControlMessage("seek", { timeSeconds: 1.25 }, 60)).toEqual({
      source: "hf-parent",
      type: "control",
      action: "seek",
      protocolVersion: 1,
      capabilities: [
        "seconds-time",
        "rational-fps",
        "seek-keep-playing",
        "composition-manifest-v1",
        "runtime-data",
      ],
      fps: { numerator: 60, denominator: 1 },
      timeSeconds: 1.25,
    });
  });

  it("posts the typed message to the target window", () => {
    const target = { postMessage: vi.fn() };
    postRuntimeControlMessage(target as unknown as Window, "pause");
    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pause", protocolVersion: 1 }),
      "*",
    );
  });

  it("preserves legacy 30fps messages and rejects unknown majors", () => {
    expect(inspectStudioRuntimeMessage({ source: "hf-preview" })).toEqual({
      status: "legacy",
      fps: 30,
    });
    expect(inspectStudioRuntimeMessage({ protocolVersion: 2 })).toMatchObject({
      status: "unsupported",
      code: "unsupported_protocol_version",
    });
  });

  it("reads explicit fps for accepted timeline messages", () => {
    const message = createRuntimeControlMessage("pause", {}, 60);
    expect(acceptedRuntimeMessageFps(message)).toBe(60);
    expect(acceptStudioRuntimeMessage(message)).toMatchObject({ status: "supported", fps: 60 });
  });

  it("preserves the protocol's exact rational timebase for native editing", () => {
    const message = {
      source: "hf-preview",
      type: "timeline",
      protocolVersion: 1,
      capabilities: ["seconds-time", "rational-fps"],
      fps: { numerator: 30_000, denominator: 1_001 },
    };

    expect(acceptedRuntimeMessageFrameRate(message)).toEqual({
      numerator: 30_000,
      denominator: 1_001,
    });
    expect(acceptedRuntimeMessageFrameRate({ source: "legacy-preview" })).toEqual({
      numerator: 30,
      denominator: 1,
    });
  });
});
