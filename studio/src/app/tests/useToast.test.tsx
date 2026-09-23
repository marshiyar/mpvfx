// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
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
