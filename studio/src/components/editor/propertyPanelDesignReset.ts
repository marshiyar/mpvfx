import type { DomEditSelection } from "./domEditingTypes";

export const DESIGN_RESET_3D_IDENTITY = {
  z: 0,
  scale: 1,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  transformPerspective: 0,
} as const;

function isFailedResetOutcome(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "ok" in value && value.ok === false);
}

/**
 * Joins Layout's GSAP-backed 3D values to the header's authored DOM reset.
 * Motion X/Y/rotation animations remain motion; only the stable 3D Layout
 * controls shown in Design are returned to identity.
 */
export async function resetDesignWithAnimatedLayout({
  selection,
  runtimeValues,
  resetDom,
  resetAnimated,
}: {
  selection: DomEditSelection;
  runtimeValues: Record<string, number>;
  resetDom: () => unknown | Promise<unknown>;
  resetAnimated?: (
    selection: DomEditSelection,
    properties: Record<string, number | string>,
  ) => void | Promise<void>;
}): Promise<unknown> {
  const domResult = await resetDom();
  if (isFailedResetOutcome(domResult)) return domResult;

  const hasCustom3dValue = Object.entries(DESIGN_RESET_3D_IDENTITY).some(
    ([property, defaultValue]) =>
      runtimeValues[property] !== undefined && runtimeValues[property] !== defaultValue,
  );
  if (hasCustom3dValue && resetAnimated) {
    await resetAnimated(selection, { ...DESIGN_RESET_3D_IDENTITY });
  }
  return domResult;
}
