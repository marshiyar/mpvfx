export function shouldShowTimelineLayerGroupHeader(
  contextKey: string,
  previousContextKey: string,
): boolean {
  return contextKey !== "" && contextKey !== previousContextKey;
}
