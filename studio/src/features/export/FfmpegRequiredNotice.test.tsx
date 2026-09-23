// @vitest-environment happy-dom

// The card's job is to be actionable at the exact moment someone is stuck.
// The case worth pinning is a recheck that finds nothing: it changes no other
// pixel on screen, so without an explicit cue the button reads as broken.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FfmpegRequiredNotice } from "./FfmpegRequiredNotice";
import type { FfmpegStatus } from "./useFfmpegStatus";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MISSING: FfmpegStatus = {
  ok: false,
  title: "Bundled media tools unavailable",
  detail: "MpVFX cannot access the FFmpeg and FFprobe executables shipped inside the application.",
  hint: "Reinstall MpVFX to restore its bundled media tools.",
};

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function render(props: {
  status?: FfmpegStatus;
  checking?: boolean;
  onRecheck?: () => void;
}): void {
  act(() => {
    root?.render(
      <FfmpegRequiredNotice
        status={props.status ?? MISSING}
        checking={props.checking ?? false}
        onRecheck={props.onRecheck ?? vi.fn()}
      />,
    );
  });
}

describe("FfmpegRequiredNotice", () => {
  it("offers only an application repair and never a system FFmpeg installation", () => {
    render({});

    expect(host.querySelector("code")).toBeNull();
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain("Bundled media tools unavailable");
    expect(host.textContent).toContain("Reinstall MpVFX");
    expect(host.textContent).not.toMatch(/brew|winget|apt install|download ffmpeg/i);
  });

  it("says so when a recheck still finds nothing", () => {
    render({ checking: false });
    expect(host.textContent).not.toContain("Still unavailable");

    render({ checking: true });
    expect(host.textContent).toContain("Checking…");

    render({ checking: false });
    expect(host.textContent).toContain("Still unavailable");
  });

  it("retires the cue so it cannot be mistaken for the card's steady state", () => {
    render({ checking: false });
    render({ checking: true });
    render({ checking: false });
    expect(host.textContent).toContain("Still unavailable");

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(host.textContent).not.toContain("Still unavailable");
  });

  it("shows no cue before the user has ever asked for a recheck", () => {
    render({ checking: false });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(host.textContent).not.toContain("Still unavailable");
  });

  it("shows the bundled-runtime repair hint", () => {
    render({
      status: {
        ok: false,
        title: "Bundled media tools unavailable",
        hint: "Reinstall MpVFX to restore its bundled media tools.",
      },
    });

    expect(host.querySelector("code")).toBeNull();
    expect(host.textContent).toContain("Reinstall MpVFX");
  });
});
