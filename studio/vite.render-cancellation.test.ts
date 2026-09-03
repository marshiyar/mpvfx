import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRenderCancellationRegistry } from "./vite.render-cancellation";

const adapterSource = readFileSync(join(import.meta.dirname, "vite.adapter.ts"), "utf8");

describe("render process cancellation registry", () => {
  it("aborts the producer signal exactly once when the server receives an explicit cancel", () => {
    const registry = createRenderCancellationRegistry({ sweepIntervalMs: 0 });
    const render = registry.register("render-1");
    const onAbort = vi.fn();
    render.signal.addEventListener("abort", onAbort);

    expect(registry.cancel("render-1")).toBe(true);
    expect(render.signal.aborted).toBe(true);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(registry.cancel("render-1")).toBe(false);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("cancels every active FFmpeg render when the local server closes", () => {
    const registry = createRenderCancellationRegistry({ sweepIntervalMs: 0 });
    const first = registry.register("render-1");
    const second = registry.register("render-2");

    registry.dispose();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(registry.activeCount()).toBe(0);
  });

  it("expires an orphaned render after the editor crashes and heartbeats stop", () => {
    let now = 1_000;
    const registry = createRenderCancellationRegistry({
      now: () => now,
      leaseTimeoutMs: 15_000,
      sweepIntervalMs: 0,
    });
    const render = registry.register("orphan");

    now += 14_999;
    expect(registry.sweepExpired()).toBe(0);
    expect(render.signal.aborted).toBe(false);

    now += 1;
    expect(registry.sweepExpired()).toBe(1);
    expect(render.signal.aborted).toBe(true);
  });

  it("keeps a live render leased while the editor continues heartbeating", () => {
    let now = 1_000;
    const registry = createRenderCancellationRegistry({
      now: () => now,
      leaseTimeoutMs: 15_000,
      sweepIntervalMs: 0,
    });
    const render = registry.register("render-1");

    now += 10_000;
    expect(registry.heartbeat("render-1")).toBe(true);
    now += 10_000;
    expect(registry.sweepExpired()).toBe(0);
    expect(render.signal.aborted).toBe(false);
  });

  it("unregisters completed work so a later close or lease sweep cannot cancel it", () => {
    let now = 1_000;
    const registry = createRenderCancellationRegistry({
      now: () => now,
      leaseTimeoutMs: 15_000,
      sweepIntervalMs: 0,
    });
    const render = registry.register("complete");

    render.finish();
    now += 60_000;
    registry.sweepExpired();
    registry.dispose();

    expect(render.signal.aborted).toBe(false);
    expect(registry.activeCount()).toBe(0);
  });

  it("refuses a duplicate job id without cancelling the render that already owns it", () => {
    const registry = createRenderCancellationRegistry({ sweepIntervalMs: 0 });
    const stale = registry.register("same-id");

    expect(() => registry.register("same-id")).toThrow(/already active/i);
    expect(stale.signal.aborted).toBe(false);
    stale.finish();
    expect(registry.activeCount()).toBe(0);
  });

  it("passes the leased AbortSignal into the producer and cancels it on server close", () => {
    expect(adapterSource).toContain("renderCancellations.register(opts.jobId)");
    expect(adapterSource).toMatch(/executeRenderJob\([\s\S]*?cancellation\.signal[\s\S]*?\)/);
    expect(adapterSource).toContain('server.httpServer?.once("close"');
    expect(adapterSource).toContain("renderCancellations.dispose()");
  });

  it("checks cancellation again after optional resizing and immediately before publish", () => {
    expect(adapterSource).toMatch(
      /if \(dimensionPlan\.resizeDimensions(?:\s*&&\s*![a-zA-Z]+)?\)[\s\S]*?if \(cancellation\.signal\.aborted\)[\s\S]*?removeCancelledOutput\(\)[\s\S]*?return;[\s\S]*?renameSync\(staging\.encodedOutputPath, opts\.outputPath\)/,
    );
  });

  it("keeps the installed FFmpeg runner's graceful-then-forced termination contract", () => {
    const producerSource = readFileSync(
      join(import.meta.dirname, "node_modules/@hyperframes/producer/dist/index.js"),
      "utf8",
    );
    expect(producerSource).toContain('signal.addEventListener("abort"');
    expect(producerSource).toContain('this.child.kill("SIGTERM")');
    expect(producerSource).toContain('this.child.kill("SIGKILL")');
  });
});
