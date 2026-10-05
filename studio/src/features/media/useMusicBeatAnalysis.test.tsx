// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayerStore, type TimelineElement } from "../../player/store/playerStore";
import { addBeatAtCompositionTime, canAddBeatAt } from "./beatEditActions";
import { useAdjustedBeatAnalysis, useMusicBeatAnalysis } from "./useMusicBeatAnalysis";

const { io, analyzeMusicFromUrl } = vi.hoisted(() => ({
  io: { readOptionalProjectFile: vi.fn(), writeProjectFile: vi.fn() },
  analyzeMusicFromUrl: vi.fn(),
}));
vi.mock("../history/FileManagerContext", () => ({ useFileManagerContextOptional: () => io }));
vi.mock("@hyperframes/core/beats", async (importOriginal) => ({
  ...await importOriginal<typeof import("@hyperframes/core/beats")>(),
  analyzeMusicFromUrl,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const analysis = {
  beatTimes: [1, 2], beatStrengths: [0.7, 0.8], bpm: 120,
  bpmConfidence: "high" as const, channelData: null, sampleRate: 48_000, peak: 1,
};
let adjustedTimes: number[] | undefined;

function Harness() {
  useMusicBeatAnalysis();
  adjustedTimes = useAdjustedBeatAnalysis()?.beatTimes;
  return null;
}

function audio(id: string, src: string, timelineRole?: string): TimelineElement {
  return { id, domId: id, tag: "audio", src, start: 0, duration: 10, track: 1, timelineRole };
}

beforeEach(() => {
  vi.clearAllMocks();
  io.readOptionalProjectFile.mockResolvedValue(null);
  io.writeProjectFile.mockResolvedValue(undefined);
  analyzeMusicFromUrl.mockResolvedValue(analysis);
  adjustedTimes = undefined;
  usePlayerStore.setState({ elements: [], beatAnalysis: null, beatEdits: null, beatPersist: null, beatUndo: [], beatRedo: [] });
});

describe("first-use music beat analysis", () => {
  it.each([
    ["explicit music", audio("bgm", "/api/projects/p/preview/assets/explicit.wav", "music")],
    ["generic imported audio", audio("recording", "/api/projects/p/preview/assets/generic.wav")],
  ])("analyzes %s without a saved beats file and enables an editable grid", async (_name, clip) => {
    usePlayerStore.setState({ elements: [clip] });
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<Harness />); });
      expect(analyzeMusicFromUrl).toHaveBeenCalledWith(clip.src);
      expect(usePlayerStore.getState().beatAnalysis?.beatTimes).toEqual([1, 2]);
      expect(adjustedTimes).toEqual([1, 2]);
      expect(canAddBeatAt(3)).toBe(true);
      act(() => addBeatAtCompositionTime(3));
      expect(usePlayerStore.getState().beatEdits?.added.map(beat => beat.time)).toEqual([3]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
    expect(io.writeProjectFile).toHaveBeenCalledWith(
      expect.stringContaining("beats/assets/"),
      expect.stringContaining('"time": 3'),
    );
  });

  it("uses saved beat times when reopening an analyzed music clip", async () => {
    const clip = audio("bgm", "/api/projects/p/preview/assets/saved.wav", "music");
    io.readOptionalProjectFile.mockResolvedValue(JSON.stringify({
      version: 1, audio: "assets/saved.wav", beats: [{ time: 4, strength: 0.4 }],
    }));
    usePlayerStore.setState({ elements: [clip] });
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<Harness />); });
      expect(usePlayerStore.getState().beatAnalysis?.beatTimes).toEqual([4]);
      expect(adjustedTimes).toEqual([4]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
