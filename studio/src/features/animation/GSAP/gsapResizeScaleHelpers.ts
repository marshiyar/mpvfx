import type { GsapAnimation } from "@hyperframes/core/gsap-parser";

export const IDENTITY_ONE_PROPS = new Set(["opacity", "autoAlpha", "scale", "scaleX", "scaleY"]);

/** Build identity (zero / one) values for each property in `source`. */
export function synthesizeIdentityProps(
  source: Record<string, number | string>,
): Record<string, number | string> {
  const id: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number") id[key] = IDENTITY_ONE_PROPS.has(key) ? 1 : 0;
    else id[key] = value;
  }
  return id;
}

/** Measured pre-draft CSS box, falling back to its saved inline dimension. */
export function originalBoxSize(
  el: HTMLElement | null,
  measuredAttr: string,
  inlineProperty: "width" | "height",
): number | null {
  const measured = Number.parseFloat(el?.getAttribute(measuredAttr) ?? "");
  if (Number.isFinite(measured) && measured > 0) return measured;
  const inline = Number.parseFloat(
    el?.getAttribute(`data-hf-studio-original-${inlineProperty}`) ?? "",
  );
  return Number.isFinite(inline) && inline > 0 ? inline : null;
}

/** Keep a tween's scale shorthand and longhands from fighting each other. */
export function tweenUsesScaleLonghands(anim: GsapAnimation | null): boolean {
  const isLonghand = (name: string) => name === "scaleX" || name === "scaleY";
  const inKeyframes = (anim?.keyframes?.keyframes ?? []).some((frame) =>
    Object.keys(frame.properties ?? {}).some(isLonghand),
  );
  return inKeyframes || Object.keys(anim?.properties ?? {}).some(isLonghand);
}
