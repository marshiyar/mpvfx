/** Keep a run's requested colour visible when an inherited text fill paints it. */
export function reconcileInlineTextFill(host: Element): void {
  const view = host.ownerDocument.defaultView;
  if (!view?.getComputedStyle) return;
  for (const span of host.querySelectorAll<HTMLElement>("span")) {
    if (!span.style.color) continue;
    const existingFill = readFill(span);
    if (existingFill === span.style.color) removeFill(span);
    const computed = view.getComputedStyle(span) as CSSStyleDeclaration & {
      webkitTextFillColor?: string;
    };
    const fill = computed.webkitTextFillColor;
    if (fill && computed.color && fill !== computed.color) {
      writeFill(span, span.style.color);
    }
  }
}

function readFill(span: HTMLElement): string {
  const supported = span.style.getPropertyValue("-webkit-text-fill-color");
  if (supported) return supported;
  const declaration = span.getAttribute("style")?.split(";").find((part) =>
    /^\s*-webkit-text-fill-color\s*:/i.test(part)
  );
  return declaration?.slice(declaration.indexOf(":") + 1).trim() ?? "";
}

function removeFill(span: HTMLElement): void {
  span.style.removeProperty("-webkit-text-fill-color");
  if (!readFill(span)) return;
  const declarations = (span.getAttribute("style") ?? "").split(";").filter((part) =>
    part.trim() && !/^\s*-webkit-text-fill-color\s*:/i.test(part)
  );
  span.setAttribute("style", `${declarations.join("; ").trim()};`);
}

function writeFill(span: HTMLElement, color: string): void {
  span.style.setProperty("-webkit-text-fill-color", color);
  if (span.style.getPropertyValue("-webkit-text-fill-color") === color) return;
  // Some DOM implementations omit vendor properties from CSSStyleDeclaration.
  // The authored style attribute remains portable to browsers that render it.
  const declarations = (span.getAttribute("style") ?? "").split(";").filter((part) =>
    part.trim() && !/^\s*-webkit-text-fill-color\s*:/i.test(part)
  );
  declarations.push(`-webkit-text-fill-color: ${color}`);
  span.setAttribute("style", `${declarations.join("; ").trim()};`);
}
