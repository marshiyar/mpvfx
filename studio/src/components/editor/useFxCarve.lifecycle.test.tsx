// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CARVE, type HfCarveSettings } from "@hyperframes/core/audio-carve";
import type { DomEditSelection } from "./domEditingTypes";
import { useFxCarve } from "./useFxCarve";
import { usePlayerStore } from "../../player";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type CarveApi = ReturnType<typeof useFxCarve>;

function selectionWithVoice(): DomEditSelection {
  const bed = document.createElement("audio");
  bed.id = "track";
  // Neutral naming keeps auto-carve out of this lifecycle test; the manual
  // setCarve below is the only operation allowed to start an analysis.
  bed.setAttribute("src", "track.wav");
  bed.setAttribute("data-start", "0");
  document.body.append(bed);

  const voice = document.createElement("audio");
  voice.id = "narration";
  voice.setAttribute("src", "voice.wav");
  voice.setAttribute("data-start", "0");
  document.body.append(voice);

  const guest = document.createElement("audio");
  guest.id = "guest";
  guest.setAttribute("src", "guest.wav");
  guest.setAttribute("data-start", "0");
  document.body.append(guest);

  return {
    id: bed.id,
    element: bed,
    dataAttributes: { start: "0", duration: "10" },
  } as unknown as DomEditSelection;
}

function HookHost({
  onApi,
  selection,
  onSetAttributeQuiet,
  writeAutomation,
  setAnalysing,
}: {
  onApi: (api: CarveApi) => void;
  selection: DomEditSelection;
  onSetAttributeQuiet: (attr: string, value: string | null) => void | Promise<void>;
  writeAutomation: (next: Parameters<Parameters<typeof useFxCarve>[5]>[0]) =>
    | void
    | Promise<void>;
  setAnalysing: ReturnType<typeof vi.fn>;
}) {
  onApi(
    useFxCarve(
      selection,
      { version: 1, nodes: [] },
      null,
      { version: 1, lanes: [] },
      onSetAttributeQuiet,
      writeAutomation,
      setAnalysing,
    ),
  );
  return null;
}

function mountCarve(options: {
  writeAutomation?: (next: Parameters<Parameters<typeof useFxCarve>[5]>[0]) =>
    | void
    | Promise<void>;
} = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const writes = vi.fn();
  const writeAutomation = vi.fn(options.writeAutomation ?? (() => undefined));
  const setAnalysing = vi.fn();
  let api: CarveApi | null = null;
  act(() => {
    root.render(
      <HookHost
        onApi={(next) => (api = next)}
        selection={selectionWithVoice()}
        onSetAttributeQuiet={writes}
        writeAutomation={writeAutomation}
        setAnalysing={setAnalysing}
      />,
    );
  });
  if (!api) throw new Error("carve hook did not render");
  return { root, api: api as CarveApi, writes, writeAutomation, setAnalysing };
}

async function flushMicrotasks(count = 8): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
}

function decodedSpeech(amplitude = 0.4): AudioBuffer {
  const sampleRate = 48_000;
  const samples = Float32Array.from({ length: sampleRate }, (_, index) =>
    amplitude * Math.sin((2 * Math.PI * 700 * index) / sampleRate),
  );
  return {
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
  usePlayerStore.setState({ elements: [] });
  document.body.innerHTML = "";
});

describe("voice carve lifecycle", () => {
  it("aborts analysis on unmount and never writes a graph from the stale decode", async () => {
    usePlayerStore.setState({ elements: [] });
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

    const mounted = mountCarve();

    let run!: Promise<void>;
    await act(async () => {
      run = mounted.api.setCarve({
        ...DEFAULT_CARVE,
        sources: ["narration"],
      } as HfCarveSettings);
      await flushMicrotasks();
    });
    act(() => mounted.root.unmount());

    expect(fetchSignal?.aborted).toBe(true);
    releaseDecode(decodedSpeech());
    await run;

    expect(mounted.writes.mock.calls.map(([attr]) => attr)).toEqual(["data-fx-carve"]);
    expect(mounted.writeAutomation).not.toHaveBeenCalled();
    expect(mounted.setAnalysing.mock.calls.at(-1)).toEqual([true]);
  });

  it("lets a newer voice selection supersede an older analysis that finishes last", async () => {
    const fetchSignals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.signal) fetchSignals.push(init.signal);
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      }),
    );

    let releaseFirst!: (buffer: AudioBuffer) => void;
    let releaseSecond!: (buffer: AudioBuffer) => void;
    let decodeCount = 0;
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData = vi.fn(
          () =>
            new Promise<AudioBuffer>((resolve) => {
              decodeCount += 1;
              if (decodeCount === 1) releaseFirst = resolve;
              else releaseSecond = resolve;
            }),
        );
      },
    );

    const mounted = mountCarve();
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = mounted.api.setCarve({
        ...DEFAULT_CARVE,
        strength: 0,
        sources: ["narration"],
      } as HfCarveSettings);
      await flushMicrotasks();
      second = mounted.api.setCarve({
        ...DEFAULT_CARVE,
        strength: 0,
        sources: ["guest"],
      } as HfCarveSettings);
      await flushMicrotasks();
    });

    expect(fetchSignals[0]?.aborted).toBe(true);
    expect(fetchSignals[1]?.aborted).toBe(false);

    releaseSecond(decodedSpeech(0.7));
    await act(async () => second);
    releaseFirst(decodedSpeech(0.2));
    await first;

    expect(mounted.writes.mock.calls.filter(([attr]) => attr === "data-fx-chain")).toHaveLength(1);
    expect(mounted.setAnalysing.mock.calls).toEqual([[true], [true], [false]]);
    act(() => mounted.root.unmount());
  });

  it("does not finish analysis until the generated automation is durable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
    );
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData = vi.fn(async () => decodedSpeech());
      },
    );

    let releaseAutomation!: () => void;
    const automationPending = new Promise<void>((resolve) => {
      releaseAutomation = resolve;
    });
    const mounted = mountCarve({ writeAutomation: () => automationPending });
    let settled = false;
    const run = mounted.api.setCarve({
      ...DEFAULT_CARVE,
      sources: ["narration"],
    } as HfCarveSettings);
    void run.then(() => {
      settled = true;
    });
    await flushMicrotasks(16);

    expect(mounted.writeAutomation).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    releaseAutomation();
    await act(async () => run);
    expect(settled).toBe(true);
    act(() => mounted.root.unmount());
  });
});
