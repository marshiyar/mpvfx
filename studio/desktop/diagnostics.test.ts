import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startDesktopDiagnostics } from "./diagnostics";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Array<(...args: unknown[]) => void>>(),
  getGPUInfo: vi.fn(), updateMetadata: vi.fn(), record: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    getVersion: () => "test", getAppPath: () => ".", setPath: vi.fn(),
    whenReady: () => Promise.resolve(), isReady: () => true, getAppMetrics: () => [],
    getGPUFeatureStatus: () => ({ gpu_compositing: "enabled" }),
    getGPUInfo: mocks.getGPUInfo,
    on: (event: string, fn: (...args: unknown[]) => void) => {
      mocks.handlers.set(event, [...(mocks.handlers.get(event) ?? []), fn]);
    },
  },
  crashReporter: { start: vi.fn(), getUploadToServer: () => false }, dialog: {},
}));
vi.mock("../diagnostics/processes", () => ({ installProcessDiagnostics: vi.fn() }));
vi.mock("../diagnostics/logger", () => ({ createDiagnostics: () => ({
  updateMetadata: mocks.updateMetadata, record: mocks.record, close: vi.fn(),
}) }));

let close: (() => void) | undefined;
let directory: string | undefined;
const consoleMethods = { log: console.log, info: console.info, warn: console.warn, error: console.error };
const processListeners = new Map(["warning", "uncaughtExceptionMonitor"].map(event => [event, process.listeners(event)]));
afterEach(() => {
  close?.();
  Object.assign(console, consoleMethods);
  for (const [event, previous] of processListeners) {
    for (const listener of process.listeners(event)) {
      if (!previous.includes(listener)) process.removeListener(event, listener);
    }
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
  mocks.handlers.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it.each([false, true])("bounds GPU snapshots even when collection emits gpu-info-update (%s)", async (emitsUpdate) => {
  vi.useFakeTimers();
  mocks.getGPUInfo.mockImplementation(async () => {
    if (emitsUpdate) for (const handler of mocks.handlers.get("gpu-info-update") ?? []) handler();
    return { gpuDevice: [{ vendorId: 1 }] };
  });
  directory = mkdtempSync(join(tmpdir(), "mpvfx-gpu-test-"));
  close = startDesktopDiagnostics(directory).close;
  await vi.advanceTimersByTimeAsync(6000);
  expect(mocks.getGPUInfo.mock.calls).toEqual([["basic"], ["complete"]]);
  expect(mocks.updateMetadata).toHaveBeenLastCalledWith(expect.objectContaining({ gpu: expect.objectContaining({ detail: "complete" }) }));
});
