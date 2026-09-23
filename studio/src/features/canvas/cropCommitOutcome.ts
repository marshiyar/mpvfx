/**
 * DOM edit commits normally resolve an outcome instead of rejecting handled
 * persistence failures. Legacy callbacks may still return void, which means
 * they completed successfully.
 */
export function didCropCommitLand(outcome: unknown): boolean {
  if (!outcome || typeof outcome !== "object") return true;
  return !("ok" in outcome && (outcome as { ok?: unknown }).ok === false);
}
