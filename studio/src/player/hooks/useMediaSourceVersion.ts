import { useEffect, useReducer } from "react";
import { subscribeMediaSourceChange } from "../lib/mediaSourceChanges";

/** Only mounted consumers retain revision state; inactive cache entries are evicted. */
export function useMediaSourceVersion(projectId: string, source: string): number {
  const [revision, bump] = useReducer((value: number) => value + 1, 0);
  useEffect(() => subscribeMediaSourceChange(projectId, source, bump), [projectId, source]);
  return revision;
}
