// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountRenderQueue, type MountedQueue } from "./renderQueueTestHarness";

vi.mock("../../telemetry/policy", () => ({ browserTelemetryAllowed: () => false }));
vi.mock("../../telemetry/config", () => ({ getAnonymousId: () => "unused" }));
vi.mock("../../telemetry/events", () => ({ trackStudioRenderStart: vi.fn() }));
vi.mock("../feedback/feedbackTrigger", () => ({ requestStudioFeedback: vi.fn() }));
vi.mock("./useFfmpegStatus", () => ({
  ffmpegInstallMessage: () => "FFmpeg unavailable",
  useFfmpegStatus: () => ({ status: { ok: true }, checking: false, recheck: vi.fn() }),
}));

const { useRenderQueue } = await import("./useRenderQueue");

type ProgressListener = (event: MessageEvent<string>) => void;

class FakeEventSource {
  static latest: FakeEventSource | null = null;
  private listeners = new Map<string, ProgressListener>();
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    FakeEventSource.latest = this;
  }

  addEventListener(name: string, listener: ProgressListener): void {
    this.listeners.set(name, listener);
  }

  emit(name: string, data: unknown): void {
    this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  close(): void {}
}

let queue: MountedQueue | null = null;

afterEach(() => {
  queue?.unmount();
  queue = null;
  FakeEventSource.latest = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("completed export metadata reconciliation", () => {
  it("merges the persisted file size into the same row after SSE completion", async () => {
    let renderComplete = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Response.json({ jobId: "render-1", status: "rendering" });
      }
      if (url.endsWith("/renders")) {
        return Response.json({
          renders: renderComplete
            ? [
                {
                  id: "render-1",
                  filename: "render-1.mp4",
                  createdAt: 100,
                  size: 2.5 * 1024 * 1024,
                  status: "complete",
                  durationMs: 250,
                },
              ]
            : [],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);

    queue = mountRenderQueue(useRenderQueue, "demo");
    await act(async () => {
      await queue?.api().startRender({ format: "mp4", quality: "standard", fps: 30 });
    });

    renderComplete = true;
    await act(async () => {
      FakeEventSource.latest?.emit("progress", { status: "complete", progress: 100 });
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(queue?.api().jobs).toHaveLength(1);
      expect(queue?.api().jobs[0]).toMatchObject({
        id: "render-1",
        status: "complete",
        sizeBytes: 2.5 * 1024 * 1024,
      });
    });
  });
});
