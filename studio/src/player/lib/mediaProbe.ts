import { resolveMediaPreviewUrl } from "../components/thumbnailUtils";
import { TIMELINE_VIEWPORT_BUDGETS } from "./timelineViewportBudgets";
import { projectMediaSourcePath } from "./mediaSourceChanges";

export interface MediaProbeResult {
  duration: number;
  width?: number;
  height?: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface CachedProbe {
  result: MediaProbeResult;
  lastAccess: number;
}

const cache = new Map<string, CachedProbe>();
interface ProbeJob {
  key: string;
  epoch: number;
  cancelled: boolean;
  controller: AbortController;
  promise: Promise<MediaProbeResult | null>;
  resolve: (result: MediaProbeResult | null) => void;
}
const inflight = new Map<string, ProbeJob>();
// URLs whose probe failed (CORS, 404, non-media). Remembered so the rAF-driven
// timeline re-derive doesn't re-fetch them every frame and flood the console.
const failed = new Map<string, { failedAt: number; lastAccess: number }>();
let accessSequence = 0;
let activeProbes = 0;
let registryEpoch = 0;
const probeQueue: ProbeJob[] = [];

let mediabunnyModule: typeof import("mediabunny") | null | false = null;

async function loadMediabunny() {
  if (mediabunnyModule === false) return null;
  if (mediabunnyModule) return mediabunnyModule;
  try {
    mediabunnyModule = await import("mediabunny");
    return mediabunnyModule;
  } catch {
    mediabunnyModule = false;
    return null;
  }
}

function normalizeUrl(url: string): string {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

async function probeOne(url: string, signal: AbortSignal): Promise<MediaProbeResult | null> {
  const mb = await loadMediabunny();
  if (!mb || signal.aborted) return null;

  const input = new mb.Input({
    source: new mb.UrlSource(url, { requestInit: { cache: "no-store" } }),
    formats: mb.ALL_FORMATS,
  });
  const dispose = () => input.dispose();
  signal.addEventListener("abort", dispose, { once: true });
  try {
    const duration = await input.getDurationFromMetadata();
    if (duration == null || !Number.isFinite(duration) || duration <= 0) return null;

    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTracks = await input.getAudioTracks();

    const result: MediaProbeResult = {
      duration,
      width: videoTrack?.displayWidth,
      height: videoTrack?.displayHeight,
      hasVideo: videoTrack != null,
      hasAudio: audioTracks.length > 0,
    };
    return result;
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", dispose);
    if (!signal.aborted) input.dispose();
  }
}

function getCachedProbe(url: string): MediaProbeResult | undefined {
  const cached = cache.get(normalizeUrl(url));
  if (cached) cached.lastAccess = ++accessSequence;
  return cached?.result;
}

function resolveProbeSource(src: string, projectId: string | null): string {
  return normalizeUrl(
    projectId ? resolveMediaPreviewUrl(src, projectId, window.location.href) : src,
  );
}

export interface MediaProbeTarget {
  projectId: string | null;
  source: string;
  tag: string;
}

export function matchesMediaProbeSource(
  source: string | undefined,
  target: MediaProbeTarget,
): boolean {
  return !!source && resolveProbeSource(source, target.projectId) === target.source;
}

function evictMetadataOverflow(): void {
  const overflow = cache.size + failed.size - TIMELINE_VIEWPORT_BUDGETS.metadataRegistryEntries;
  if (overflow <= 0) return;
  const entries = [
    ...Array.from(cache, ([key, value]) => ({ key, at: value.lastAccess, failed: false })),
    ...Array.from(failed, ([key, value]) => ({ key, at: value.lastAccess, failed: true })),
  ].sort((left, right) => left.at - right.at);
  for (const entry of entries.slice(0, overflow)) {
    if (entry.failed) failed.delete(entry.key);
    else cache.delete(entry.key);
  }
}

/**
 * The current source probe owns duration facts. Timeline rediscovery can omit
 * them or report the old decoder's duration after same-path media replacement.
 */
export function applyCachedSourceDurations<
  T extends { src?: string; tag: string; sourceDuration?: number },
>(elements: T[], projectId: string | null): T[] {
  return elements.map((el) => {
    const tag = el.tag.toLowerCase();
    if (!el.src || (tag !== "audio" && tag !== "video")) return el;
    const cached = getCachedProbe(resolveProbeSource(el.src, projectId));
    return cached?.duration && cached.duration > 0 && cached.duration !== el.sourceDuration
      ? { ...el, sourceDuration: cached.duration }
      : el;
  });
}

/**
 * Probe (header-only, cheap) any media elements still missing sourceDuration
 * after the cache pass, applying each resolved duration via `apply(key, secs)`.
 * Skips already-cached srcs.
 */
export async function probeMissingSourceDurations<
  T extends { src?: string; tag: string; sourceDuration?: number; key?: string; id: string },
>(
  elements: T[],
  projectId: string | null,
  apply: (key: string, durationSeconds: number, target: MediaProbeTarget) => void,
): Promise<void> {
  const needs = elements.flatMap((el) => {
    if (
      !el.src ||
      el.sourceDuration != null ||
      !["video", "audio"].includes(el.tag.toLowerCase())
    ) {
      return [];
    }
    const source = resolveProbeSource(el.src, projectId);
    return !getCachedProbe(source) && !hasFreshFailure(normalizeUrl(source))
      ? [{ key: el.key ?? el.id, tag: el.tag.toLowerCase(), source }]
      : [];
  });
  if (needs.length === 0) return;
  await Promise.allSettled(
    needs.map(async ({ key, tag, source }) => {
      const result = await probeMediaUrl(source);
      if (result && getCachedProbe(source) === result)
        apply(key, result.duration, { projectId, source, tag });
    }),
  );
}

function hasFreshFailure(key: string): boolean {
  const failedAt = failed.get(key);
  if (failedAt === undefined) return false;
  if (Date.now() - failedAt.failedAt < TIMELINE_VIEWPORT_BUDGETS.metadataFailureTtlMs) {
    failedAt.lastAccess = ++accessSequence;
    return true;
  }
  failed.delete(key);
  return false;
}

export async function probeMediaUrl(url: string): Promise<MediaProbeResult | null> {
  const key = normalizeUrl(url);
  const cached = getCachedProbe(key);
  if (cached) return cached;
  if (hasFreshFailure(key)) return null;

  const pending = inflight.get(key);
  if (pending) return pending.promise;
  let resolve!: ProbeJob["resolve"];
  const promise = new Promise<MediaProbeResult | null>((accept) => {
    resolve = accept;
  });
  const job: ProbeJob = {
    key,
    epoch: registryEpoch,
    cancelled: false,
    controller: new AbortController(),
    promise,
    resolve,
  };
  inflight.set(key, job);
  probeQueue.push(job);
  pumpProbeQueue();
  return promise;
}

function pumpProbeQueue(): void {
  while (activeProbes < TIMELINE_VIEWPORT_BUDGETS.concurrentMetadataJobs) {
    const queued = probeQueue.shift();
    if (!queued) return;
    if (queued.cancelled || queued.epoch !== registryEpoch) {
      queued.resolve(null);
      continue;
    }
    activeProbes++;
    void probeOne(queued.key, queued.controller.signal)
      .catch(() => null)
      .then((result) => {
        if (queued.cancelled || queued.epoch !== registryEpoch) return null;
        inflight.delete(queued.key);
        if (result) cache.set(queued.key, { result, lastAccess: ++accessSequence });
        else failed.set(queued.key, { failedAt: Date.now(), lastAccess: ++accessSequence });
        evictMetadataOverflow();
        return result;
      })
      .then(queued.resolve)
      .finally(() => {
        activeProbes--;
        pumpProbeQueue();
      });
  }
}

export function getMediaProbeDiagnostics() {
  return { cached: cache.size, failed: failed.size, inflight: inflight.size };
}

/** Forget only facts and work whose exact project file has changed. */
export function invalidateMediaProbeSource(projectId: string, path: string): void {
  for (const key of new Set([...cache.keys(), ...failed.keys(), ...inflight.keys()])) {
    if (projectMediaSourcePath(key, projectId) !== path) continue;
    cache.delete(key);
    failed.delete(key);
    const job = inflight.get(key);
    if (job) {
      job.cancelled = true;
      job.controller.abort();
      job.resolve(null);
      inflight.delete(key);
    }
  }
}

export function resetMediaProbeRegistry(): void {
  registryEpoch++;
  for (const job of inflight.values()) {
    job.controller.abort();
    job.resolve(null);
  }
  for (const queued of probeQueue.splice(0)) queued.resolve(null);
  cache.clear();
  failed.clear();
  inflight.clear();
  accessSequence = 0;
}
