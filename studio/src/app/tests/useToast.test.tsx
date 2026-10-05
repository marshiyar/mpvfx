// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useToast } from "../useToast";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows one persistent notification per error while preserving distinct failures", () => {
  let state!: ReturnType<typeof useToast>;
  function Harness() { state = useToast(); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    act(() => root.render(<Harness />));
    act(() => {
      state.showToast("Save conflict", "error");
      state.showToast("Save conflict", "error");
      state.showToast("Save conflict", "error");
      state.showToast("Disk full", "error");
    });
    expect(state.toasts.map((toast) => toast.message)).toEqual(["Save conflict", "Disk full"]);
  } finally {
    act(() => root.unmount());
  }
});

it("keeps failures visible when routine notices arrive and deduplicates repeated notices", () => {
  let state!: ReturnType<typeof useToast>;
  function Harness() { state = useToast(); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    act(() => root.render(<Harness />));
    act(() => {
      state.showToast("Saved", "info");
      state.showToast("Saved", "info");
      state.showToast("Save conflict", "error");
      state.showToast("Export queued", "info");
      state.showToast("Disk full", "error");
    });
    expect(state.toasts.map((toast) => toast.message)).toEqual([
      "Save conflict", "Export queued", "Disk full",
    ]);
    act(() => {
      state.showToast("More info", "info");
      state.showToast("Permission denied", "error");
      state.showToast("Routine update", "info");
    });
    expect(state.toasts.map((toast) => toast.message)).toEqual([
      "Save conflict", "Disk full", "Permission denied",
    ]);
  } finally {
    act(() => root.unmount());
  }
});

it("schedules expiry only for displayed info notices", () => {
  vi.useFakeTimers();
  let state!: ReturnType<typeof useToast>;
  function Harness() { state = useToast(); return null; }
  const root = createRoot(document.createElement("div"));
  try {
    act(() => root.render(<Harness />));
    act(() => {
      state.showToast("Saved", "info");
      state.showToast("Saved", "info");
      state.showToast("Saved", "info");
    });
    expect(state.toasts.map((toast) => toast.message)).toEqual(["Saved"]);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(4000));
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]?.leaving).toBe(true);
    act(() => vi.advanceTimersByTime(160));
    expect(state.toasts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      state.showToast("Save conflict", "error");
      state.showToast("Disk full", "error");
      state.showToast("Permission denied", "error");
      state.showToast("Saved", "info");
    });
    expect(state.toasts).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});

it("groups repeated native clip patch failures and retains every distinct diagnostic", () => {
  let state!: ReturnType<typeof useToast>;
  function Harness() { state = useToast(); return null; }
  const root = createRoot(document.createElement("div"));
  const first = "Compatibility source index.html did not accept the patch for native clip native-split:one";
  const second = "Compatibility source index.html did not accept the patch for native clip native-split:two";
  try {
    act(() => root.render(<Harness />));
    act(() => {
      state.showToast(first, "error");
      state.showToast(second, "error");
      state.showToast(second, "error");
      state.showToast("Compatibility source scene.html did not accept the patch for native clip other", "error");
    });
    expect(state.toasts).toHaveLength(2);
    expect(state.toasts[0]).toMatchObject({ occurrences: 3, details: [first, second] });
    expect(state.toasts[1]?.occurrences).toBe(1);
  } finally {
    act(() => root.unmount());
  }
});
