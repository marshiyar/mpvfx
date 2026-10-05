import type { DesktopEvents } from "../../lib/desktopClient";

type FileChangeEvents = Pick<DesktopEvents, "addEventListener" | "close" | "onerror">;

/** Restore a dropped desktop event stream and reconcile changes missed during the gap. */
export function subscribeDesktopFileChanges(
  create: () => FileChangeEvents,
  onChange: (event: MessageEvent<string>) => void,
  onReconnected: () => void,
  onUnavailable?: () => void,
  onRecovered?: () => void,
): () => void {
  let closed = false;
  let source: FileChangeEvents | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  let missedEvents = false;

  const scheduleRetry = () => {
    if (closed || timer) return;
    missedEvents = true;
    const delay = Math.min(1000 * 2 ** Math.min(consecutiveFailures++, 4), 15000);
    if (consecutiveFailures === 3) onUnavailable?.();
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
  };
  const open = () => {
    if (closed) return;
    try {
      const current = create();
      source = current;
      current.addEventListener("file-change", onChange);
      current.addEventListener("ready", () => {
        if (closed || source !== current) return;
        consecutiveFailures = 0;
        if (missedEvents) {
          missedEvents = false;
          onRecovered?.();
          onReconnected();
        }
      });
      current.onerror = () => {
        if (closed || source !== current) return;
        current.close();
        source = null;
        scheduleRetry();
      };
    } catch {
      source = null;
      scheduleRetry();
    }
  };

  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    source?.close();
    source = null;
  };
}
