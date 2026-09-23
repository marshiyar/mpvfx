import { useEffect } from "react";
import { hasFiredSessionStart, markSessionStartFired } from "../telemetry/config";
import { trackStudioSessionStart } from "../telemetry/events";

export function useStudioSessionStart(
  projectId: string | null,
  resolving: boolean,
  waitingForRuntime: boolean,
): void {
  useEffect(() => {
    if (resolving || waitingForRuntime || hasFiredSessionStart()) return;
    markSessionStartFired();
    trackStudioSessionStart({ has_project: projectId != null });
  }, [projectId, resolving, waitingForRuntime]);
}
