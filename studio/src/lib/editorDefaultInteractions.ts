import { isTypingTarget } from "./typingTarget";

function targetElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== "object") return null;
  const candidate = target as Element & { parentElement?: Element | null };
  if (typeof candidate.closest === "function") return candidate;
  return candidate.parentElement && typeof candidate.parentElement.closest === "function"
    ? candidate.parentElement
    : null;
}

/** The editor chrome is a control surface; editable fields keep browser selection. */
export function shouldBlockChromeSelection(target: EventTarget | null): boolean {
  const element = targetElement(target);
  return element !== null && !isTypingTarget(element);
}

/** Only suppress native image/link ghost drags, leaving authored DnD sources alone. */
export function shouldBlockNativeGhostDrag(target: EventTarget | null): boolean {
  const element = targetElement(target);
  if (!element || isTypingTarget(element) || element.closest('[draggable="true"]')) return false;
  return element.closest("img, a[href]") !== null;
}
