// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StudioToast } from "../StudioToast";
import { toastGroupKey, toastPresentation } from "../toastPresentation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("keeps a giant native-id failure compact while exposing and copying complete details", async () => {
  const first = "Compatibility source index.html did not accept the patch for native clip native-split:one";
  const second = "Compatibility source index.html did not accept the patch for native clip native-split:two";
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const onDismiss = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    act(() => root.render(<StudioToast message={first} tone="error" occurrences={2} details={[first, second]} onDismiss={onDismiss} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't save the clip edit in index.html.");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("×2");
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain("native-split:one");
    const disclosure = host.querySelector("details");
    expect(disclosure?.open).toBe(false);
    act(() => host.querySelector("summary")?.click());
    expect(disclosure?.open).toBe(true);
    expect(host.querySelector("pre")?.textContent).toContain(first);
    expect(host.querySelector("pre")?.textContent).toContain(second);
    await act(async () => host.querySelectorAll("button")[1]?.click());
    expect(writeText).toHaveBeenCalledWith(`${first}\n\n${second}`);
    expect(host.textContent).toContain("Copied");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]')?.click());
    expect(onDismiss).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

it("uses a brief status presentation and keeps unrelated errors separate", () => {
  const longError = `Save failed: ${"native-id-".repeat(20)}`;
  expect(toastPresentation(longError, "error").summary.length).toBeLessThan(100);
  expect(toastGroupKey("Save conflict", "error")).not.toBe(toastGroupKey("Disk full", "error"));
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<StudioToast message="Saved" tone="info" />));
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Saved");
  expect(host.querySelector("details")).toBeNull();
  act(() => root.unmount());
});
