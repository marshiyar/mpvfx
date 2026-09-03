// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./feedback/StudioFeedbackCard", () => ({
  StudioFeedbackCard: () => <div data-feedback-card="" />,
}));

vi.mock("./StudioToast", () => ({
  StudioToast: ({ message }: { message: string }) => <div data-toast="">{message}</div>,
}));

import { StudioOverlays } from "./StudioOverlays";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

it("does not place a dashed file-drop prompt over the editor", () => {
  const host = document.createElement("div");
  const root = createRoot(host);

  act(() => {
    root.render(<StudioOverlays toasts={[]} dismissToast={vi.fn()} />);
  });

  expect(host.textContent).not.toContain("Drop to add at the playhead");
  expect(host.querySelector(".border-dashed")).toBeNull();
  act(() => root.unmount());
});
