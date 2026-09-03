// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HfAutomation } from "@hyperframes/core/audio-automation";
import type { HfAudioFxChain } from "@hyperframes/core/audio-fx";
import type { DomEditSelection } from "./domEditingTypes";
import { useFxLevelling } from "./useFxLevelling";

vi.mock("@hyperframes/core/audio-leveller", async (importOriginal) => {
  const original = await importOriginal<typeof import("@hyperframes/core/audio-leveller")>();
  return {
    ...original,
    levellingResult: vi.fn((chain: HfAudioFxChain) => ({
      chain: {
        version: 1,
        nodes: [
          ...chain.nodes,
          { type: "gain", id: "level-1", enabled: true, params: { gain: 0 } },
        ],
      },
      automation: {
        version: 1,
        lanes: [{ target: "fx.level-1.gain", points: [{ t: 0, v: 3 }, { t: 1, v: 0 }] }],
      },
    })),
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_CHAIN: HfAudioFxChain = { version: 1, nodes: [] };
const EMPTY_AUTOMATION: HfAutomation = { version: 1, lanes: [] };

function audioSelection(): DomEditSelection {
  const audio = document.createElement("audio");
  audio.id = "voiceover";
  audio.setAttribute("src", "voice.wav");
  document.body.append(audio);
  return {
    id: audio.id,
    element: audio,
    dataAttributes: {},
  } as unknown as DomEditSelection;
}

type LevellingApi = ReturnType<typeof useFxLevelling>;

function HookHost({
  onApi,
  selection,
  onSetAttributeQuiet,
  setAnalysing,
}: {
  onApi: (api: LevellingApi) => void;
  selection: DomEditSelection;
  onSetAttributeQuiet: (attr: string, value: string | null) => void | Promise<void>;
  setAnalysing: (value: boolean) => void;
}) {
  onApi(
    useFxLevelling(
      selection,
      EMPTY_CHAIN,
      EMPTY_AUTOMATION,
      onSetAttributeQuiet,
      vi.fn(),
      setAnalysing,
    ),
  );
  return null;
}

function mountLevelling(
  onSetAttributeQuiet: (attr: string, value: string | null) => void | Promise<void> = vi.fn(),
) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const setAnalysing = vi.fn();
  let api: LevellingApi | null = null;
  act(() => {
    root.render(
      <HookHost
        onApi={(next) => (api = next)}
        selection={audioSelection()}
        onSetAttributeQuiet={onSetAttributeQuiet}
        setAnalysing={setAnalysing}
      />,
    );
  });
  return {
    root,
    getApi: (): LevellingApi => {
      if (!api) throw new Error("levelling hook did not render");
      return api;
    },
    setAnalysing,
  };
}

function decodedBuffer(samples = Float32Array.from([0.1, 0.4, 0.2])): AudioBuffer {
  return {
    sampleRate: 48_000,
    numberOfChannels: 1,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

async function flushMicrotasks(count = 8): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("voice levelling lifecycle", () => {
  it("aborts an in-flight decode on unmount and never persists its stale result", async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined;
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      }),
    );

    let releaseDecode!: (buffer: AudioBuffer) => void;
    const decodePending = new Promise<AudioBuffer>((resolve) => {
      releaseDecode = resolve;
    });
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData = vi.fn(() => decodePending);
      },
    );

    const writes = vi.fn();
    const mounted = mountLevelling(writes);
    let run!: Promise<void>;
    await act(async () => {
      run = mounted.getApi().runLeveller();
      await flushMicrotasks();
    });

    act(() => mounted.root.unmount());
    expect(fetchSignal?.aborted).toBe(true);

    releaseDecode(decodedBuffer());
    await run;
    expect(writes).not.toHaveBeenCalled();
  });

  it("treats an HTTP media failure as a failed measurement instead of decoding the error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );
    const decodeAudioData = vi.fn(async () => decodedBuffer());
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData = decodeAudioData;
      },
    );

    const writes = vi.fn();
    const mounted = mountLevelling(writes);
    await act(async () => mounted.getApi().runLeveller());

    expect(decodeAudioData).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(mounted.setAnalysing.mock.calls).toEqual([[true], [false]]);
    act(() => mounted.root.unmount());
  });

  it("does not resolve until both the effect chain and its automation are persisted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
    );
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData = vi.fn(async () => decodedBuffer());
      },
    );

    let releaseAutomation!: () => void;
    const automationPending = new Promise<void>((resolve) => {
      releaseAutomation = resolve;
    });
    const writes = vi.fn(async (attr: string) => {
      if (attr === "data-automation") await automationPending;
    });
    const mounted = mountLevelling(writes);
    let run!: Promise<void>;
    let settled = false;
    await act(async () => {
      run = mounted.getApi().runLeveller();
      void run.then(() => {
        settled = true;
      });
      await flushMicrotasks();
    });

    expect(writes.mock.calls.map(([attr]) => attr)).toEqual(["data-fx-chain", "data-automation"]);
    expect(settled).toBe(false);

    releaseAutomation();
    await act(async () => run);
    expect(settled).toBe(true);
    act(() => mounted.root.unmount());
  });

  it("cancels hover audition analysis before starting a committed levelling run", async () => {
    const fetchSignals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.signal) fetchSignals.push(init.signal);
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      }),
    );

    const releases: Array<(buffer: AudioBuffer) => void> = [];
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData = vi.fn(
          () =>
            new Promise<AudioBuffer>((resolve) => {
              releases.push(resolve);
            }),
        );
      },
    );

    const mounted = mountLevelling();
    let audition!: Promise<void>;
    act(() => {
      audition = mounted.getApi().auditionLevel(true);
    });
    await flushMicrotasks();
    let committed!: Promise<void>;
    act(() => {
      committed = mounted.getApi().runLeveller();
    });
    await flushMicrotasks();

    expect(fetchSignals).toHaveLength(2);
    expect(fetchSignals[0]?.aborted).toBe(true);
    expect(fetchSignals[1]?.aborted).toBe(false);

    releases[0]?.(decodedBuffer());
    releases[1]?.(decodedBuffer());
    await act(async () => Promise.all([audition, committed]));
    act(() => mounted.root.unmount());
  });
});
