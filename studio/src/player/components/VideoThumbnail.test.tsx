// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { thumbnailScheduler } from "../lib/thumbnailScheduler";
import { decodeVideoThumbnail } from "../lib/thumbnailVideoDecoder";
import { VideoThumbnail } from "./VideoThumbnail";

vi.mock("../lib/thumbnailVideoDecoder", () => ({ decodeVideoThumbnail: vi.fn() }));

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

class MockResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  thumbnailScheduler.invalidateProject("p");
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

async function render(rich = false) {
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <VideoThumbnail
        videoSrc="/api/projects/p/preview/assets/clip.mp4"
        label=""
        labelColor="#fff"
        projectId="p"
        sessionEpoch={1}
        priority="visible"
        rich={rich}
      />,
    );
    await Promise.resolve();
  });
}

describe("VideoThumbnail", () => {
  it("renders a scheduler-provided sparse poster", async () => {
    vi.mocked(decodeVideoThumbnail).mockResolvedValue({
      value: { kind: "image", url: "blob:poster", aspect: 16 / 9 },
      weight: 128,
    });

    await render();

    expect(decodeVideoThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ frameCount: 1 }),
      expect.any(AbortSignal),
    );
    expect(host.querySelector('img[src="blob:poster"]')).not.toBeNull();
    expect(host.querySelector(".animate-pulse")).toBeNull();
  });

  it("requests a rich filmstrip only for interaction actors", async () => {
    vi.mocked(decodeVideoThumbnail).mockResolvedValue({
      value: { kind: "filmstrip", urls: ["blob:a", "blob:b"], aspect: 16 / 9 },
      weight: 256,
    });

    await render(true);

    expect(decodeVideoThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ frameCount: 6 }),
      expect.any(AbortSignal),
    );
    expect(host.querySelectorAll("img").length).toBeGreaterThan(0);
  });

  it("keeps the poster visible while a hovered clip loads its richer filmstrip", async () => {
    let resolveRich:
      | ((value: {
          value: { kind: "filmstrip"; urls: string[]; aspect: number };
          weight: number;
        }) => void)
      | undefined;
    vi.mocked(decodeVideoThumbnail).mockImplementation((request) => {
      if (request.frameCount === 1) {
        return Promise.resolve({
          value: { kind: "image", url: "blob:poster", aspect: 16 / 9 },
          weight: 128,
        });
      }
      return new Promise((resolve) => {
        resolveRich = resolve;
      });
    });

    root = createRoot(host);
    const draw = async (rich: boolean) => {
      await act(async () => {
        root!.render(
          <VideoThumbnail
            videoSrc="/api/projects/p/preview/assets/clip.mp4"
            label=""
            labelColor="#fff"
            projectId="p"
            sessionEpoch={1}
            priority={rich ? "interaction" : "visible"}
            rich={rich}
          />,
        );
        await Promise.resolve();
      });
    };

    await draw(false);
    expect(host.querySelector('img[src="blob:poster"]')).not.toBeNull();

    await draw(true);
    expect(resolveRich).toBeTypeOf("function");
    expect(host.querySelector('img[src="blob:poster"]')).not.toBeNull();

    await act(async () => {
      resolveRich?.({
        value: { kind: "filmstrip", urls: ["blob:rich-a", "blob:rich-b"], aspect: 16 / 9 },
        weight: 256,
      });
      await Promise.resolve();
    });
    expect(host.querySelector('img[src="blob:rich-a"]')).not.toBeNull();
  });

  it("clears the loading shimmer when the scheduled decode fails", async () => {
    vi.mocked(decodeVideoThumbnail).mockRejectedValue(new Error("decode failed"));

    await render();
    await vi.waitFor(() => expect(thumbnailScheduler.getDiagnostics().active).toBe(0));

    expect(host.querySelector(".animate-pulse")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
  });
});
