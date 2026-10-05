// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeDesktopFileChanges } from "./desktopFileChangeSubscription";

class FakeEvents {
  onerror: (() => void) | null = null;
  readonly close = vi.fn();
  private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data = ""): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data }));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("desktop file-change subscription", () => {
  it("retries a failed stream and reconciles only after the replacement is ready", () => {
    vi.useFakeTimers();
    const first = new FakeEvents();
    const second = new FakeEvents();
    const create = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const onChange = vi.fn();
    const reconcile = vi.fn();
    const stop = subscribeDesktopFileChanges(create, onChange, reconcile);

    first.emit("ready");
    expect(reconcile).not.toHaveBeenCalled();
    first.onerror?.();
    expect(first.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(999);
    expect(create).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(reconcile).not.toHaveBeenCalled();
    second.emit("ready");
    second.emit("ready");
    expect(reconcile).toHaveBeenCalledOnce();
    second.emit("file-change", '{"path":"index.html"}');
    expect(onChange.mock.calls[0][0].data).toBe('{"path":"index.html"}');
    stop();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("backs off repeated failures and cancels pending retry on close", () => {
    vi.useFakeTimers();
    const first = new FakeEvents();
    const second = new FakeEvents();
    const create = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const stop = subscribeDesktopFileChanges(create, vi.fn(), vi.fn());
    first.onerror?.();
    vi.advanceTimersByTime(1000);
    second.onerror?.();
    vi.advanceTimersByTime(1999);
    expect(create).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(30000);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("recovers when creating the stream throws synchronously", () => {
    vi.useFakeTimers();
    const ready = new FakeEvents();
    const create = vi.fn().mockImplementationOnce(() => { throw Error("bridge unavailable"); })
      .mockReturnValueOnce(ready);
    const reconcile = vi.fn();
    const stop = subscribeDesktopFileChanges(create, vi.fn(), reconcile);
    vi.advanceTimersByTime(1000);
    ready.emit("ready");
    expect(reconcile).toHaveBeenCalledOnce();
    stop();
  });

  it("surfaces a persistent outage once and clears it after connection returns", () => {
    vi.useFakeTimers();
    const streams: FakeEvents[] = [];
    const create = () => {
      const stream = new FakeEvents();
      streams.push(stream);
      return stream;
    };
    const unavailable = vi.fn();
    const recovered = vi.fn();
    const stop = subscribeDesktopFileChanges(create, vi.fn(), vi.fn(), unavailable, recovered);
    streams[0]!.onerror?.();
    vi.advanceTimersByTime(1000);
    streams[1]!.onerror?.();
    vi.advanceTimersByTime(2000);
    streams[2]!.onerror?.();
    expect(unavailable).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(4000);
    streams[3]!.emit("ready");
    expect(recovered).toHaveBeenCalledOnce();
    stop();
  });
});
