// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  static instances: FakeEventSource[] = [];
  readonly url: string;
  close = vi.fn();
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ProgressListener>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: ProgressListener): void {
    this.listeners.set(name, listener);
  }

  emit(data: unknown): void {
    this.listeners.get("progress")?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

let queue: MountedQueue | null = null;
let fetchMock: ReturnType<typeof vi.fn>;
let sendBeacon: ReturnType<typeof vi.fn>;
let nextJob = 0;
let cancelResponse: (jobId: string) => Promise<Response>;
let originalSendBeacon: PropertyDescriptor | undefined;

beforeEach(() => {
  nextJob = 0;
  FakeEventSource.instances = [];
  cancelResponse = async () => Response.json({ status: "cancelled" });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/renders") && (!init?.method || init.method === "GET")) {
      return Response.json({ renders: [] });
    }
    if (/\/api\/projects\/[^/]+\/render$/.test(url) && init?.method === "POST") {
      nextJob += 1;
      return Response.json({ jobId: `job-${nextJob}`, status: "rendering" });
    }
    const cancel = url.match(/^\/api\/render\/([^/]+)\/cancel$/);
    if (cancel && init?.method === "POST") return cancelResponse(decodeURIComponent(cancel[1]));
    if (/^\/api\/render\/[^/]+\/heartbeat$/.test(url) && init?.method === "POST") {
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  sendBeacon = vi.fn(() => true);
  originalSendBeacon = Object.getOwnPropertyDescriptor(navigator, "sendBeacon");
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: sendBeacon,
  });
});

afterEach(() => {
  queue?.unmount();
  queue = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalSendBeacon) Object.defineProperty(navigator, "sendBeacon", originalSendBeacon);
  else Reflect.deleteProperty(navigator, "sendBeacon");
  document.body.innerHTML = "";
});

async function startRender(): Promise<string> {
  if (!queue) queue = mountRenderQueue(useRenderQueue, "demo");
  let id: string | undefined;
  await act(async () => {
    id = (await queue?.api().startRender({})) as unknown as string | undefined;
  });
  if (!id) throw new Error("render did not start");
  return id;
}

function cancellationPosts(jobId: string): Array<[string, RequestInit]> {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      url === `/api/render/${jobId}/cancel` && (init as RequestInit | undefined)?.method === "POST",
  ) as Array<[string, RequestInit]>;
}

describe("render cancellation lifecycle", () => {
  it("waits for server confirmation before calling a render cancelled", async () => {
    let finishCancel: ((response: Response) => void) | null = null;
    cancelResponse = () => new Promise<Response>((resolve) => (finishCancel = resolve));
    const jobId = await startRender();

    let pending: Promise<void> | undefined;
    act(() => {
      pending = queue?.api().cancelRender(jobId);
    });
    await act(async () => Promise.resolve());

    expect(queue?.api().jobs[0]?.status).toBe("rendering");
    expect(FakeEventSource.instances[0]?.close).not.toHaveBeenCalled();
    expect(cancellationPosts(jobId)[0]?.[1]).toMatchObject({ method: "POST", keepalive: true });

    await act(async () => {
      finishCancel?.(Response.json({ status: "cancelled" }));
      await pending;
    });

    expect(queue?.api().jobs[0]?.status).toBe("cancelled");
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("does not lie about cancellation when the server refuses the request", async () => {
    cancelResponse = async () => Response.json({ error: "busy" }, { status: 500 });
    const jobId = await startRender();

    await act(async () => {
      await queue?.api().cancelRender(jobId);
    });

    expect(queue?.api().jobs[0]?.status).toBe("rendering");
    expect(queue?.api().actionError).toContain("may still be running");
    expect(FakeEventSource.instances[0]?.close).not.toHaveBeenCalled();
  });

  it("keeps tracking the render when the cancel transport itself fails", async () => {
    cancelResponse = async () => {
      throw new TypeError("connection reset");
    };
    const jobId = await startRender();

    await act(async () => {
      await queue?.api().cancelRender(jobId);
    });

    expect(queue?.api().jobs[0]?.status).toBe("rendering");
    expect(queue?.api().actionError).toContain("Couldn't reach the server");
    expect(FakeEventSource.instances[0]?.close).not.toHaveBeenCalled();
  });

  it("preserves a terminal result when the job finishes before cancellation lands", async () => {
    cancelResponse = async () => Response.json({ status: "complete" });
    const jobId = await startRender();

    await act(async () => {
      await queue?.api().cancelRender(jobId);
      await Promise.resolve();
    });

    expect(queue?.api().jobs[0]?.status).toBe("complete");
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledTimes(1);
  });

  it.each(["pagehide", "beforeunload"])(
    "sends an immediate best-effort cancel on %s",
    async (eventName) => {
      const jobId = await startRender();

      act(() => window.dispatchEvent(new Event(eventName)));

      expect(sendBeacon).toHaveBeenCalledWith(`/api/render/${jobId}/cancel`);
      expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledTimes(1);
    },
  );

  it("falls back to keepalive fetch when the browser rejects sendBeacon", async () => {
    sendBeacon.mockReturnValue(false);
    const jobId = await startRender();

    act(() => window.dispatchEvent(new Event("pagehide")));

    expect(sendBeacon).toHaveBeenCalledWith(`/api/render/${jobId}/cancel`);
    expect(cancellationPosts(jobId)[0]?.[1]).toMatchObject({ method: "POST", keepalive: true });
  });

  it("cancels every active render and closes every progress stream on unmount", async () => {
    const first = await startRender();
    const second = await startRender();

    queue?.unmount();
    queue = null;

    expect(sendBeacon).toHaveBeenCalledWith(`/api/render/${first}/cancel`);
    expect(sendBeacon).toHaveBeenCalledWith(`/api/render/${second}/cancel`);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances.every((source) => source.close.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("does not cancel a render that already reached a terminal status", async () => {
    const jobId = await startRender();
    await act(async () => {
      FakeEventSource.instances[0]?.emit({ status: "complete", progress: 100 });
      await Promise.resolve();
    });

    act(() => window.dispatchEvent(new Event("pagehide")));

    expect(sendBeacon).not.toHaveBeenCalledWith(`/api/render/${jobId}/cancel`);
  });

  it("cancels the producer when its progress connection fails", async () => {
    const jobId = await startRender();

    act(() => FakeEventSource.instances[0]?.onerror?.());

    expect(sendBeacon).toHaveBeenCalledWith(`/api/render/${jobId}/cancel`);
    expect(queue?.api().jobs[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Connection lost"),
    });
  });

  it("heartbeats only while a render is active", async () => {
    vi.useFakeTimers();
    const jobId = await startRender();
    const heartbeatUrl = `/api/render/${jobId}/heartbeat`;

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    const beforeComplete = fetchMock.mock.calls.filter(([url]) => url === heartbeatUrl);
    expect(beforeComplete).toHaveLength(1);
    expect(beforeComplete[0]?.[1]).toMatchObject({ method: "POST", keepalive: true });

    await act(async () => {
      FakeEventSource.instances[0]?.emit({ status: "complete", progress: 100 });
      await Promise.resolve();
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.filter(([url]) => url === heartbeatUrl)).toHaveLength(1);
  });
});
