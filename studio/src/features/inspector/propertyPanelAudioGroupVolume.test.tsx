// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "../canvas/domEditingTypes";
import { AudioFxGroup } from "./propertyPanelAudioFxGroup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.innerHTML = ""; });

function mountBus(volume?: string) {
  const bus = document.createElement("hf-audio-group");
  bus.id = "dialogue";
  if (volume) bus.setAttribute("data-volume", volume);
  document.body.append(bus);
  const host = document.createElement("div");
  document.body.append(host);
  const quiet = vi.fn();
  const live = vi.fn();
  const root = createRoot(host);
  const selection = {
    id: bus.id, tagName: "hf-audio-group", element: bus,
    dataAttributes: volume ? { volume } : {},
  } as unknown as DomEditSelection;
  act(() => root.render(
    <AudioFxGroup element={selection} onSetAttributeQuiet={quiet} onSetAttributeLive={live} />,
  ));
  return { host, root, quiet, live };
}

describe("audio group rack volume", () => {
  it("offers the bus fader and saves an exact gain attribute", () => {
    const { host, root, quiet } = mountBus();
    const slider = host.querySelector<HTMLElement>('[role="slider"][aria-label="Group volume"]');
    expect(slider).not.toBeNull();
    expect(host.textContent).toContain("0.0 dB");
    act(() => slider!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(quiet).toHaveBeenCalledWith("data-volume", "0.933254");
    act(() => root.unmount());
  });

  it("resets a custom bus level by removing its authored attribute", () => {
    const { host, root, quiet } = mountBus("0.5");
    const slider = host.querySelector<HTMLElement>('[role="slider"][aria-label="Group volume"]');
    expect(host.textContent).toContain("-6.0 dB");
    act(() => slider!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(quiet).toHaveBeenCalledWith("data-volume", null);
    act(() => root.unmount());
  });
});
