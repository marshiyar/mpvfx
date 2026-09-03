// Background tabs can have timers throttled to roughly one callback per
// minute. Leave enough room for that without allowing a crashed editor to
// orphan FFmpeg indefinitely.
export const DEFAULT_RENDER_LEASE_TIMEOUT_MS = 90_000;
export const DEFAULT_RENDER_LEASE_SWEEP_INTERVAL_MS = 2_500;

export interface RenderCancellationLifecycle {
  signal: AbortSignal;
  cancel(): void;
  finish(): void;
}

export interface RenderCancellationRegistry {
  register(jobId: string): RenderCancellationLifecycle;
  heartbeat(jobId: string): boolean;
  cancel(jobId: string): boolean;
  cancelAll(): void;
  sweepExpired(): number;
  activeCount(): number;
  dispose(): void;
}

interface ActiveRender {
  controller: AbortController;
  lastHeartbeatAt: number;
}

export function createRenderCancellationRegistry({
  now = Date.now,
  leaseTimeoutMs = DEFAULT_RENDER_LEASE_TIMEOUT_MS,
  sweepIntervalMs = DEFAULT_RENDER_LEASE_SWEEP_INTERVAL_MS,
}: {
  now?: () => number;
  leaseTimeoutMs?: number;
  sweepIntervalMs?: number;
} = {}): RenderCancellationRegistry {
  const active = new Map<string, ActiveRender>();

  const cancel = (jobId: string): boolean => {
    const entry = active.get(jobId);
    if (!entry) return false;
    active.delete(jobId);
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(new DOMException("Render cancelled", "AbortError"));
    }
    return true;
  };

  const sweepExpired = (): number => {
    let cancelled = 0;
    const cutoff = now() - leaseTimeoutMs;
    for (const [jobId, entry] of active) {
      if (entry.lastHeartbeatAt <= cutoff && cancel(jobId)) cancelled += 1;
    }
    return cancelled;
  };

  const timer =
    sweepIntervalMs > 0
      ? setInterval(sweepExpired, Math.max(1, sweepIntervalMs))
      : null;
  // This safety timer must not keep a CLI/dev-server process alive by itself.
  timer?.unref?.();

  return {
    register(jobId) {
      // The shared server currently derives ids at one-second precision. A
      // rapid duplicate must not steal the existing job's cancellation slot:
      // doing so lets the second job cancel or delete the first one's output.
      if (active.has(jobId)) {
        throw new Error(`Render job "${jobId}" is already active`);
      }
      const entry: ActiveRender = {
        controller: new AbortController(),
        lastHeartbeatAt: now(),
      };
      active.set(jobId, entry);
      return {
        signal: entry.controller.signal,
        cancel: () => void cancel(jobId),
        finish: () => {
          // Do not let a stale lifecycle unregister a newer job with the same id.
          if (active.get(jobId) === entry) active.delete(jobId);
        },
      };
    },
    heartbeat(jobId) {
      const entry = active.get(jobId);
      if (!entry) return false;
      entry.lastHeartbeatAt = now();
      return true;
    },
    cancel,
    cancelAll() {
      for (const jobId of [...active.keys()]) cancel(jobId);
    },
    sweepExpired,
    activeCount: () => active.size,
    dispose() {
      if (timer) clearInterval(timer);
      for (const jobId of [...active.keys()]) cancel(jobId);
    },
  };
}
