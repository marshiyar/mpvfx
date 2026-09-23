// @vitest-environment happy-dom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TimelineResizeDivider } from "../TimelineResizeDivider";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

function mountDivider() {
  const host = document.createElement("div");
  document.body.append(host);
  const persist = vi.fn();
  const container = document.createElement("div");
  container.getBoundingClientRect = () => ({ top: 0, height: 800 }) as DOMRect;
  function Harness() {
    const [height, setHeight] = useState(300);
    return <TimelineResizeDivider timelineH={height} setTimelineH={setHeight}
      persistTimelineH={persist} containerRef={{ current: container }} disabled={false} />;
  }
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  const divider = host.querySelector<HTMLElement>('[role="separator"]')!;
  const child = divider.firstElementChild as HTMLElement;
  divider.setPointerCapture = vi.fn();
  child.setPointerCapture = vi.fn();
  const pointer = (target: HTMLElement, type: string, overrides: PointerEventInit = {}) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: 1, ...overrides }));
  return { divider, child, persist, pointer, height: () => Number(divider.getAttribute("aria-valuenow")) };
}

it("captures the divider owner and ends once on capture loss, ignoring trailing motion", () => {
  const h = mountDivider();
  act(() => h.pointer(h.child, "pointerdown", { clientY: 500 }));
  expect(h.divider.setPointerCapture).toHaveBeenCalledWith(1);
  expect(h.child.setPointerCapture).not.toHaveBeenCalled();
  act(() => h.pointer(h.divider, "pointermove", { clientY: 420 }));
  expect(h.height()).toBe(380);
  act(() => h.pointer(h.divider, "lostpointercapture"));
  act(() => {
    h.pointer(h.divider, "pointermove", { clientY: 310 });
    h.pointer(h.divider, "pointerup", { buttons: 0 });
    h.pointer(h.child, "pointermove", { clientY: 415, buttons: 0 });
  });
  expect(h.height()).toBe(380);
  expect(h.persist).toHaveBeenCalledExactlyOnceWith(380);
});

it("ignores another pointer and buttonless movement during a resize", () => {
  const h = mountDivider();
  act(() => h.pointer(h.divider, "pointerdown"));
  act(() => {
    h.pointer(h.divider, "pointermove", { clientY: 300, pointerId: 2 });
    h.pointer(h.divider, "pointerup", { pointerId: 2 });
    h.pointer(h.divider, "pointermove", { clientY: 300, buttons: 0 });
  });
  expect(h.height()).toBe(300);
  expect(h.persist).not.toHaveBeenCalled();
  act(() => h.pointer(h.divider, "pointermove", { clientY: 400 }));
  act(() => h.pointer(h.divider, "pointerup", { buttons: 0 }));
  expect(h.height()).toBe(400);
  expect(h.persist).toHaveBeenCalledExactlyOnceWith(400);
});

it("persists the final move when release arrives before React renders it", () => {
  const h = mountDivider();
  act(() => {
    h.pointer(h.divider, "pointerdown");
    h.pointer(h.divider, "pointermove", { clientY: 430 });
    h.pointer(h.divider, "pointermove", { clientY: 390 });
    h.pointer(h.divider, "pointerup", { buttons: 0 });
  });
  expect(h.height()).toBe(410);
  expect(h.persist).toHaveBeenCalledExactlyOnceWith(410);
});
