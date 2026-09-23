import { desktopRequest } from "../lib/desktopClient";
import { useEffect, useState } from "react";
import { buildProjectHash, parseProjectIdFromHash } from "./projectRouting";
import { useMountEffect } from "./useMountEffect";

interface DesktopProjectState {
  projectId: string | null;
  resolving: boolean;
  waitingForRuntime: boolean;
}

/** Load the active local project through Electron, retrying while its runtime starts. */
export function useDesktopProject(): DesktopProjectState {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [waitingForRuntime, setWaitingForRuntime] = useState(false);

  useMountEffect(() => {
    const hashProjectId = parseProjectIdFromHash(window.location.hash);
    let cancelled = false;
    // Explicitly `number` (the DOM return of window.setTimeout) rather than
    // ReturnType<typeof window.setTimeout> — with @types/node present, that infers
    // NodeJS.Timeout and clashes with the DOM number the call actually returns.
    let retryTimer: number | null = null;

    function scheduleRetry() {
      setWaitingForRuntime(true);
      retryTimer = window.setTimeout(tryConnect, 2000);
    }

    function tryConnect() {
      desktopRequest("/api/projects")
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          if (hashProjectId) {
            setProjectId(hashProjectId);
            setWaitingForRuntime(false);
          } else {
            const first = (data.projects ?? [])[0];
            if (first) {
              setProjectId(first.id);
              setWaitingForRuntime(false);
              window.location.hash = buildProjectHash(first.id);
            } else {
              scheduleRetry();
            }
          }
        })
        .catch(() => {
          if (!cancelled) scheduleRetry();
        })
        .finally(() => {
          if (!cancelled) setResolving(false);
        });
    }

    tryConnect();
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  });

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const onHashChange = () => {
      const next = parseProjectIdFromHash(window.location.hash);
      if (next && next !== projectId) setProjectId(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [projectId]);

  return { projectId, resolving, waitingForRuntime };
}
