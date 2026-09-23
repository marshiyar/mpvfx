// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCachedSourceDurations,
  getMediaProbeDiagnostics,
  probeMediaUrl,
  probeMissingSourceDurations,
  resetMediaProbeRegistry,
  invalidateMediaProbeSource,
} from "../mediaProbe";

const dispose = vi.fn();
const getDurationFromMetadata = vi.fn(async () => 5);
const requestedSources: string[] = [];

vi.mock("mediabunny", () => ({
  ALL_FORMATS: {},
  UrlSource: class {
    constructor(readonly url: string) {
      requestedSources.push(url);
    }
  },
  Input: class {
    getDurationFromMetadata = getDurationFromMetadata;
    getPrimaryVideoTrack = vi.fn(async () => ({ displayWidth: 640, displayHeight: 360 }));
    getAudioTracks = vi.fn(async () => []);
    dispose = dispose;
  },
}));

beforeEach(() => {
  resetMediaProbeRegistry();
  vi.clearAllMocks();
  requestedSources.length = 0;
  getDurationFromMetadata.mockResolvedValue(5);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("media probe registry", () => {
  it("deduplicates and caches successful probes", async () => {
    const [first, second] = await Promise.all([
      probeMediaUrl("/video.mp4"),
      probeMediaUrl("/video.mp4"),
    ]);
    expect(first).toEqual(second);
    expect(getDurationFromMetadata).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getMediaProbeDiagnostics()).toEqual({ cached: 1, failed: 0, inflight: 0 });
  });

  it("bounds retained successes to the configured registry count", async () => {
    for (let index = 0; index < 513; index++) {
      await probeMediaUrl(`/video-${index}.mp4`);
    }
    expect(getMediaProbeDiagnostics().cached).toBe(512);
  });

  it("limits concurrent metadata probes and drains the queue", async () => {
    const resolvers: Array<(duration: number) => void> = [];
    getDurationFromMetadata.mockImplementation(
      () => new Promise<number>((resolve) => resolvers.push(resolve)),
    );

    const probes = Array.from({ length: 5 }, (_, index) => probeMediaUrl(`/queued-${index}.mp4`));
    await Promise.resolve();
    await Promise.resolve();
    expect(getDurationFromMetadata).toHaveBeenCalledTimes(4);

    resolvers[0]?.(5);
    await vi.waitFor(() => expect(getDurationFromMetadata).toHaveBeenCalledTimes(5));

    for (const resolve of resolvers.slice(1)) resolve(5);
    await expect(Promise.all(probes)).resolves.toHaveLength(5);
    expect(getMediaProbeDiagnostics()).toEqual({ cached: 5, failed: 0, inflight: 0 });
  });

  it("retries failures only after the failure TTL", async () => {
    vi.useFakeTimers();
    getDurationFromMetadata.mockRejectedValue(new Error("bad source"));
    await expect(probeMediaUrl("/bad.mp4")).resolves.toBeNull();
    await expect(probeMediaUrl("/bad.mp4")).resolves.toBeNull();
    expect(getDurationFromMetadata).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001);
    await expect(probeMediaUrl("/bad.mp4")).resolves.toBeNull();
    expect(getDurationFromMetadata).toHaveBeenCalledTimes(2);
  });

  it("probes same-origin rooted media through the active project preview", async () => {
    const apply = vi.fn();
    await probeMissingSourceDurations(
      [
        {
          id: "clip",
          tag: "video",
          src: `${window.location.origin}/assets/clip.mp4`,
        },
      ],
      "project-a",
      apply,
    );

    expect(requestedSources).toEqual([
      `${window.location.origin}/api/projects/project-a/preview/assets/clip.mp4`,
    ]);
    expect(apply).toHaveBeenCalledWith("clip", 5, {
      projectId: "project-a", tag: "video",
      source: `${window.location.origin}/api/projects/project-a/preview/assets/clip.mp4`,
    });
    expect(
      applyCachedSourceDurations(
        [
          {
            id: "clip",
            tag: "video",
            src: `${window.location.origin}/assets/clip.mp4`,
          },
        ],
        "project-a",
      ),
    ).toEqual([
      {
        id: "clip",
        tag: "video",
        src: `${window.location.origin}/assets/clip.mp4`,
        sourceDuration: 5,
      },
    ]);

    await probeMissingSourceDurations(
      [
        {
          id: "clip",
          tag: "video",
          src: `${window.location.origin}/assets/clip.mp4`,
        },
      ],
      "project-a",
      apply,
    );
    expect(requestedSources).toHaveLength(1);
  });

  it("invalidates only the changed project source, including its query variants", async () => {
    const changed = "/api/projects/a/preview/assets/clip.mp4";
    const other = "/api/projects/a/preview/assets/other.mp4";
    const foreign = "/api/projects/b/preview/assets/clip.mp4";
    await Promise.all([probeMediaUrl(changed), probeMediaUrl(`${changed}?v=old`), probeMediaUrl(other), probeMediaUrl(foreign)]);
    invalidateMediaProbeSource("a", "assets/clip.mp4");
    expect(getMediaProbeDiagnostics().cached).toBe(2);
    getDurationFromMetadata.mockResolvedValue(12);
    await expect(probeMediaUrl(changed)).resolves.toMatchObject({ duration: 12 });
    await expect(probeMediaUrl(other)).resolves.toMatchObject({ duration: 5 });
    await expect(probeMediaUrl(foreign)).resolves.toMatchObject({ duration: 5 });
  });

  it("does not let an old in-flight probe overwrite a replacement source result", async () => {
    let finish!: (duration: number) => void;
    getDurationFromMetadata.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const url = "/api/projects/a/preview/clip.mp4";
    const old = probeMediaUrl(url);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    invalidateMediaProbeSource("a", "clip.mp4");
    await expect(old).resolves.toBeNull();
    getDurationFromMetadata.mockResolvedValue(20);
    await expect(probeMediaUrl(url)).resolves.toMatchObject({ duration: 20 });
    finish(3);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(2));
    await expect(probeMediaUrl(url)).resolves.toMatchObject({ duration: 20 });
  });

  it("retries a failed source immediately when that exact file is replaced", async () => {
    const url = "/api/projects/a/preview/clip.mp4";
    getDurationFromMetadata.mockRejectedValueOnce(new Error("missing"));
    await expect(probeMediaUrl(url)).resolves.toBeNull();
    invalidateMediaProbeSource("a", "clip.mp4");
    await expect(probeMediaUrl(url)).resolves.toMatchObject({ duration: 5 });
  });
});
