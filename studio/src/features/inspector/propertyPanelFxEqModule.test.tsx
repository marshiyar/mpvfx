// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HfAudioEqBand } from "@hyperframes/core/audio-fx-eq";
import { FxEqModule } from "./propertyPanelFxEqModule";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

const BASS: HfAudioEqBand = {
  name: "Bass",
  frequency: 120,
  gain: 6,
  kind: "lowshelf",
};

function mount({ band = BASS, disabled = false }: { band?: HfAudioEqBand; disabled?: boolean } = {}) {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <FxEqModule
        eqId="eq-1"
        bands={[band]}
        open
        disabled={disabled}
        onToggleOpen={vi.fn()}
        onPreview={onPreview}
        onCommit={onCommit}
        onRemove={vi.fn()}
      />,
    );
  });
  return {
    host,
    onPreview,
    onCommit,
    reset: () => host.querySelector<HTMLButtonElement>('[aria-label="Reset Bass EQ"]')!,
    fader: () => host.querySelector<HTMLInputElement>(".hf-fx-eq-fader")!,
  };
}

describe("FxEqModule band reset", () => {
  it.each(["Escape", "pointercancel", "lostpointercapture"])("restores the band's baseline on %s and ignores the rest of the canceled drag", (ending) => {
    const { fader, onPreview, onCommit } = mount();
    const input = fader();
    const set = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    act(() => {
      input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
      set("9");
    });
    act(() => {
      if (ending === "Escape") {
        input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Escape" }));
      }
      else input.dispatchEvent(new Event(ending, { bubbles: true }));
      set("10");
      input.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    expect(onPreview).toHaveBeenLastCalledWith("Bass", 6);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("6");
  });

  it("offers a per-band reset that previews neutral and persists it exactly once", () => {
    const { reset, onPreview, onCommit } = mount();
    expect(reset()).toBeTruthy();

    act(() => reset().click());

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith("Bass", 0);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Bass", 0);
  });

  it("resets the band when its fader is double-clicked", () => {
    const { fader, onPreview, onCommit } = mount();

    act(() => fader().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith("Bass", 0);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Bass", 0);
  });

  it("keeps both reset paths inert while the EQ is disabled", () => {
    const { reset, fader, onPreview, onCommit } = mount({ disabled: true });
    expect(reset().disabled).toBe(true);
    expect(fader().disabled).toBe(true);

    act(() => {
      reset().click();
      fader().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("still exposes the reset for a neutral band without writing another history entry", () => {
    const { reset, onPreview, onCommit } = mount({ band: { ...BASS, gain: 0 } });
    expect(reset()).toBeTruthy();
    expect(reset().disabled).toBe(true);

    act(() => reset().click());
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
