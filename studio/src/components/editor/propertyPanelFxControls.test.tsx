// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FxParamRow, FxParams } from "./propertyPanelFxControls";
import type {
  HfAudioFxDef,
  HfAudioFxEnumParam,
  HfAudioFxNumberParam,
} from "@hyperframes/core/audio-fx";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

/** A frequency knob: wide range, so a clamp to the minimum is unmistakable. */
const FREQUENCY: HfAudioFxNumberParam = {
  kind: "number",
  key: "frequency",
  label: "Frequency",
  min: 20,
  max: 20000,
  step: 1,
  default: 1000,
  unit: "Hz",
};

/** React tracks its own value on the node, so a plain assignment is ignored. */
function setInputValue(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function mount(value: number) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  let root!: Root;
  act(() => {
    root = createRoot(host);
    root.render(
      <FxParamRow param={FREQUENCY} value={value} onChange={onChange} onCommit={onCommit} />,
    );
  });
  const number = () => host.querySelector<HTMLInputElement>(".hf-fx-number")!;
  const slider = () => host.querySelector<HTMLInputElement>(".hf-fx-slider")!;
  const type = (text: string) => {
    act(() => {
      number().focus();
      setInputValue(number(), text);
    });
  };
  /** A new value arrives through the prop — a carve, or an undo. */
  const receive = (next: number) => {
    act(() => {
      root.render(
        <FxParamRow param={FREQUENCY} value={next} onChange={onChange} onCommit={onCommit} />,
      );
    });
  };
  return { host, number, slider, onChange, onCommit, type, receive };
}

describe("FxParamRow number field", () => {
  it("shows what is being typed instead of snapping back to the stored value", () => {
    // Every keystroke is clamped and written live, and the live write does not
    // refresh the prop — so a field bound to the committed value put the old
    // number straight back. Typing 5000 wrote 20 on the first keystroke and the
    // knob could not be typed into at all, only dragged.
    const { number, type } = mount(1000);
    type("5");
    expect(number().value).toBe("5");
    type("5000");
    expect(number().value).toBe("5000");
  });

  it("does not write the parameter minimum while the field is empty", () => {
    // `Number("") === 0` passes Number.isFinite, so select-all + Delete before
    // retyping used to clamp to the minimum and live-write it — 20 Hz here.
    const { onChange, type } = mount(1000);
    type("");
    expect(onChange).not.toHaveBeenCalled();
    type("800");
    expect(onChange).toHaveBeenLastCalledWith("frequency", 800);
  });
});

describe("FxParamRow commit", () => {
  it("stays quiet when a gesture changed nothing", () => {
    // commit() hangs off pointerup, keyup and blur, all reachable without an
    // edit. Firing then costs a source patch, a selection resync, a preview
    // reload and an audio restart for a gesture that moved nothing.
    const { slider, number, onCommit } = mount(1000);
    act(() => slider().dispatchEvent(new Event("pointerup", { bubbles: true })));
    act(() => number().dispatchEvent(new Event("blur", { bubbles: true })));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not re-persist a stale value over a change that arrived meanwhile", () => {
    // The scenario: open an EQ row, run the carve (or press undo), which
    // rewrites the chain so this row's value becomes 400. Then click the slider
    // thumb and release without moving it. `latest` was seeded at mount and only
    // written by an edit, so it still held 1000 — and the release wrote it back,
    // undoing the carve with no gesture that looks like an edit.
    const { slider, onCommit, type, receive } = mount(1000);
    // An edit happened earlier in this row's life, so `latest` holds 1000.
    type("1000");
    act(() => slider().dispatchEvent(new Event("pointerup", { bubbles: true })));
    onCommit.mockClear();

    receive(400);
    act(() => slider().dispatchEvent(new Event("pointerup", { bubbles: true })));
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("FxParamRow reset", () => {
  const MODE: HfAudioFxEnumParam = {
    kind: "enum",
    key: "mode",
    label: "Mode",
    default: "clean",
    options: [
      { value: "clean", label: "Clean" },
      { value: "warm", label: "Warm" },
    ],
  };

  it("resets a number parameter to its registry default with one preview and one commit", () => {
    const { host, onChange, onCommit } = mount(5000);
    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Reset Frequency"]');
    expect(reset).not.toBeNull();

    act(() => reset?.click());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("frequency", FREQUENCY.default);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("frequency", FREQUENCY.default);
  });

  it("resets a number parameter when its range input is double-clicked", () => {
    const { slider, onChange, onCommit } = mount(5000);

    act(() => slider().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("frequency", FREQUENCY.default);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("frequency", FREQUENCY.default);
  });

  it("resets an enum parameter to its registry default with one preview and one commit", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    act(() => {
      createRoot(host).render(
        <FxParamRow param={MODE} value="warm" onChange={onChange} onCommit={onCommit} />,
      );
    });

    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Reset Mode"]');
    expect(reset).not.toBeNull();
    act(() => reset?.click());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("mode", MODE.default);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("mode", MODE.default);
  });

  it.each([
    { label: "disabled", props: { disabled: true } },
    { label: "automated", props: { automated: true } },
  ])("keeps number resets inert when the parameter is $label", ({ props }) => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    act(() => {
      createRoot(host).render(
        <FxParamRow
          param={FREQUENCY}
          value={5000}
          onChange={onChange}
          onCommit={onCommit}
          {...props}
        />,
      );
    });

    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Reset Frequency"]');
    const slider = host.querySelector<HTMLInputElement>(".hf-fx-slider");
    expect(reset?.disabled).toBe(true);
    act(() => {
      reset?.click();
      slider?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("keeps an enum reset inert when the effect is disabled", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    act(() => {
      createRoot(host).render(
        <FxParamRow
          param={MODE}
          value="warm"
          onChange={onChange}
          onCommit={onCommit}
          disabled
        />,
      );
    });

    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Reset Mode"]');
    expect(reset?.disabled).toBe(true);
    act(() => reset?.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("preserves every sibling parameter when FxParams merges a reset", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const def: HfAudioFxDef = {
      id: "test-effect",
      label: "Test effect",
      group: "filter",
      description: "Test only",
      web: "test",
      params: [FREQUENCY, MODE],
    };
    const params = { frequency: 5000, mode: "warm", implementationDetail: 17 };
    const host = document.createElement("div");
    document.body.append(host);
    act(() => {
      createRoot(host).render(
        <FxParams def={def} params={params} onChange={onChange} onCommit={onCommit} />,
      );
    });

    act(() =>
      host.querySelector<HTMLButtonElement>('[aria-label="Reset Frequency"]')?.click(),
    );

    const expected = { ...params, frequency: FREQUENCY.default };
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expected);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(expected);
  });
});

describe("FxParamRow label tooltip", () => {
  // The label column is a fixed 86px and truncates: "Gap between repeats" reads
  // as "Gap between re…", "How many repeats" as "How many repe…". The row
  // already carried a `title`, but that is the HINT — what the knob does — so a
  // truncated name had no way to be read in full.
  const LONG: HfAudioFxNumberParam = {
    kind: "number",
    key: "time",
    label: "Gap between repeats",
    min: 0,
    max: 1000,
    step: 1,
    default: 250,
    unit: "ms",
    hint: "How long before the echo comes back.",
  };

  it("wraps the full name rather than truncating it, and leaves the hint on the row", () => {
    const host = document.createElement("div");
    document.body.append(host);
    act(() => {
      createRoot(host).render(<FxParamRow param={LONG} value={250} onChange={vi.fn()} />);
    });
    const label = host.querySelector<HTMLElement>(".hf-fx-label");
    // The whole name is present and allowed to wrap. No `title`: a tooltip
    // answers one row on hover, wrapping answers the column at rest.
    expect(label?.textContent).toBe("Gap between repeats");
    expect(label?.className).toContain("break-words");
    expect(label?.className).not.toContain("truncate");
    expect(label?.getAttribute("title")).toBeNull();
    // The hint stays where it was: the two are different questions, and the
    // name is not a substitute for the explanation either.
    expect(host.querySelector<HTMLElement>(".hf-fx-row")?.getAttribute("title")).toBe(
      "How long before the echo comes back.",
    );
  });

  it("wraps it the same way with no hint to fall back on", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const { hint: _hint, ...noHint } = LONG;
    act(() => {
      createRoot(host).render(<FxParamRow param={noHint} value={250} onChange={vi.fn()} />);
    });
    const label = host.querySelector<HTMLElement>(".hf-fx-label");
    expect(label?.textContent).toBe("Gap between repeats");
    expect(label?.getAttribute("title")).toBeNull();
  });
});
