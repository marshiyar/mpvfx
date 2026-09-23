// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mountRenderQueue,
  renderPosts,
  startRenderAndReadBody,
  stubRenderFetch,
  type MountedQueue,
} from "./renderQueueTestHarness";

vi.mock("../../telemetry/policy", () => ({ browserTelemetryAllowed: () => false }));
vi.mock("../../telemetry/config", () => ({ getAnonymousId: () => "unused" }));
vi.mock("../../telemetry/events", () => ({ trackStudioRenderStart: vi.fn() }));

const { useRenderQueue } = await import("./useRenderQueue");
let queue: MountedQueue | null = null;

afterEach(() => {
  queue?.unmount();
  queue = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("export request parity", () => {
  it("allows only one render start while the first request is still being accepted", async () => {
    let acceptFirstRender: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          acceptFirstRender = resolve;
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ renders: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: vi.fn(() => true),
    });
    vi.stubGlobal(
      "EventSource",
      class {
        close(): void {}
        addEventListener(): void {}
      },
    );
    queue = mountRenderQueue(useRenderQueue, "demo");

    const first = queue.api().startRender({ format: "mp4" });
    const second = queue.api().startRender({ format: "mp4" });

    expect(renderPosts(fetchMock)).toHaveLength(1);
    await expect(second).resolves.toBeUndefined();

    acceptFirstRender?.(
      new Response(JSON.stringify({ jobId: "j1", status: "rendering" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await act(async () => {
      await first;
    });
  });

  it("fails safely when the render service accepts a request without returning a job id", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === "POST" ? {} : { renders: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        constructor() {
          throw new Error("invalid responses must not open progress streams");
        }
      },
    );
    queue = mountRenderQueue(useRenderQueue, "demo");

    await act(async () => {
      await queue?.api().startRender({ format: "mp4" });
    });

    expect(queue.api().jobs.at(-1)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("invalid response"),
    });
  });

  it("sends exact custom dimensions through the render request", async () => {
    const started = await startRenderAndReadBody(useRenderQueue, {
      opts: {
        format: "mp4",
        quality: "high",
        fps: 60,
        dimensions: { width: 4320, height: 7680 },
      } as never,
    });
    queue = started.queue;
    expect(started.body).toMatchObject({
      format: "mp4",
      quality: "high",
      fps: 60,
      dimensions: { width: 4320, height: 7680 },
    });
    expect(started.body).not.toHaveProperty("resolution");
  });

  it.each([
    ["mp4", "high", 60, "landscape-4k"],
    ["webm", "draft", 24, undefined],
    ["mov", "standard", 30, undefined],
  ] as const)("sends canonical %s settings", async (format, quality, fps, resolution) => {
    const started = await startRenderAndReadBody(useRenderQueue, {
      opts: { format, quality, fps, resolution: resolution ?? "auto" },
    });
    queue = started.queue;
    expect(started.body).toMatchObject({ format, quality, fps });
    if (resolution) expect(started.body.resolution).toBe(resolution);
    else expect(started.body).not.toHaveProperty("resolution");
  });

  it.each(["webm", "mov"] as const)(
    "refuses unsupported %s resolution before making a render request",
    async (format) => {
      const fetchMock = stubRenderFetch();
      queue = mountRenderQueue(useRenderQueue, "demo");
      await act(async () => {
        await queue?.api().startRender({
          format,
          quality: "standard",
          fps: 30,
          resolution: "landscape-4k",
        });
      });

      expect(renderPosts(fetchMock)).toHaveLength(0);
      expect(queue.api().jobs.at(-1)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("native resolution"),
      });
    },
  );

  it("leaves device and worker selection to the server-side automatic renderer", async () => {
    const started = await startRenderAndReadBody(useRenderQueue, {
      opts: { format: "mp4", quality: "standard", fps: 30 },
    });
    queue = started.queue;

    expect(started.body).not.toHaveProperty("workers");
    expect(started.body).not.toHaveProperty("producerConfig");
    expect(started.body).not.toHaveProperty("hardwareConcurrency");
    expect(started.body).not.toHaveProperty("deviceMemory");
  });
});
