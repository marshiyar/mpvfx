// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";

import type { TimelineElement } from "../player/store/timelineElement";
import {
  useNativeProjectBootstrap,
  type NativeProjectBootstrapState,
} from "./useNativeProjectBootstrap";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const element: TimelineElement = {
  id: "runtime-camera",
  tag: "video",
  start: 0,
  duration: 2,
  track: 0,
  authoredTrack: 0,
  sourceFile: "index.html",
  domId: "camera-a",
  hfId: "hf-camera-a",
  selector: "#camera-a",
  selectorIndex: 0,
  src: "assets/camera.mov",
};
const timelineElements = [element] as const;
const dimensions = { width: 1920, height: 1080 } as const;
const authoritativeFrameRate = { numerator: 24, denominator: 1 } as const;

const animation: GsapAnimation = {
  id: "legacy:rotation",
  targetSelector: "#camera-a",
  method: "fromTo",
  position: 0,
  resolvedStart: 0,
  duration: 1,
  properties: { rotation: -180 },
  fromProperties: { rotation: 0 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let roots: Root[] = [];
afterEach(() => {
  roots.forEach((root) => act(() => root.unmount()));
  roots = [];
  document.body.replaceChildren();
});

function renderBootstrap(
  readLegacyAnimations: (projectId: string, sourceFile: string) => Promise<readonly GsapAnimation[] | null>,
  onState: (state: NativeProjectBootstrapState) => void,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      <Harness
        readLegacyAnimations={readLegacyAnimations}
        onState={onState}
      />,
    );
  });
  return root;
}

function Harness({
  readLegacyAnimations,
  onState,
}: {
  readLegacyAnimations: (projectId: string, sourceFile: string) => Promise<readonly GsapAnimation[] | null>;
  onState: (state: NativeProjectBootstrapState) => void;
}) {
  const state = useNativeProjectBootstrap({
    status: "absent",
    projectId: "project:native-bootstrap",
    compositionDimensions: dimensions,
    frameRate: authoritativeFrameRate,
    timelineElements,
    readLegacyAnimations,
  });
  onState(state);
  return null;
}

describe("useNativeProjectBootstrap", () => {
  it("waits for legacy parsing before exposing the first native-edit candidate", async () => {
    const pending = deferred<readonly GsapAnimation[] | null>();
    const read = vi.fn(() => pending.promise);
    let latest!: NativeProjectBootstrapState;
    renderBootstrap(read, (state) => (latest = state));

    expect(latest.loading).toBe(true);
    expect(latest.document).toBeNull();
    expect(read).toHaveBeenCalledWith("project:native-bootstrap", "index.html");

    pending.resolve([animation]);
    await act(async () => {});

    expect(latest.loading).toBe(false);
    expect(latest.document?.sequence.tracks[0]?.clips[0]?.parameterTracks).toMatchObject([
      {
        parameterId: "transform.rotation",
        frameRate: authoritativeFrameRate,
        keyframes: [{ frame: 0, value: 0 }, { frame: 24, value: -180 }],
      },
    ]);
    expect(latest.diagnostics).toEqual([]);
  });

  it("keeps unsupported legacy animations in explicit fallback diagnostics without writing", async () => {
    const unsupported = { ...animation, hasUnresolvedKeyframes: true };
    const write = vi.fn();
    let latest!: NativeProjectBootstrapState;
    renderBootstrap(async () => [unsupported], (state) => (latest = state));
    await act(async () => {});

    expect(latest.loading).toBe(false);
    expect(latest.document?.sequence.tracks[0]?.clips[0]?.parameterTracks).toEqual([]);
    expect(latest.diagnostics).toContainEqual(
      expect.objectContaining({ reason: "dynamic-keyframes", disposition: "legacy-only" }),
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("does not build or parse a bootstrap candidate when a sidecar is already authoritative", async () => {
    const read = vi.fn(async () => [animation]);
    let latest!: NativeProjectBootstrapState;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => {
      root.render(
        <AuthoritativeHarness readLegacyAnimations={read} onState={(state) => (latest = state)} />,
      );
    });
    await act(async () => {});

    expect(latest.document).toBeNull();
    expect(latest.loading).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it("waits for an authoritative runtime timebase instead of guessing 30fps", async () => {
    const read = vi.fn(async () => [animation]);
    let latest!: NativeProjectBootstrapState;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => {
      root.render(
        <MissingTimebaseHarness readLegacyAnimations={read} onState={(state) => (latest = state)} />,
      );
    });
    await act(async () => {});

    expect(latest).toEqual({ loading: false, document: null, diagnostics: [] });
    expect(read).not.toHaveBeenCalled();
  });
});

function AuthoritativeHarness({
  readLegacyAnimations,
  onState,
}: {
  readLegacyAnimations: (projectId: string, sourceFile: string) => Promise<readonly GsapAnimation[] | null>;
  onState: (state: NativeProjectBootstrapState) => void;
}) {
  onState(
    useNativeProjectBootstrap({
      status: "ready",
      projectId: "project:native-bootstrap",
      compositionDimensions: dimensions,
      frameRate: authoritativeFrameRate,
      timelineElements,
      readLegacyAnimations,
    }),
  );
  return null;
}

function MissingTimebaseHarness({
  readLegacyAnimations,
  onState,
}: {
  readLegacyAnimations: (projectId: string, sourceFile: string) => Promise<readonly GsapAnimation[] | null>;
  onState: (state: NativeProjectBootstrapState) => void;
}) {
  onState(
    useNativeProjectBootstrap({
      status: "absent",
      projectId: "project:native-bootstrap",
      compositionDimensions: dimensions,
      frameRate: null,
      timelineElements,
      readLegacyAnimations,
    }),
  );
  return null;
}
