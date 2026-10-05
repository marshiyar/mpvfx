import type { AppToast } from "../lib/studioHelpers";

const MAX_SUMMARY_LENGTH = 96;
const COMPATIBILITY_PATCH = /^Compatibility source (.+?) did not accept the patch for native clip\b/i;

/** Group only a known failure family whose changing native clip id is diagnostic detail. */
export function toastGroupKey(message: string, tone: AppToast["tone"]): string {
  if (tone !== "error") return message;
  const compatibility = COMPATIBILITY_PATCH.exec(message);
  return compatibility ? `compatibility-patch:${compatibility[1]}` : message;
}

function conciseLine(message: string): string {
  const firstLine = message.trim().split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.length <= MAX_SUMMARY_LENGTH) return firstLine;
  const prefix = firstLine.slice(0, MAX_SUMMARY_LENGTH - 1);
  const wordBoundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, wordBoundary > 60 ? wordBoundary : prefix.length).trimEnd()}…`;
}

/** The raw message remains in Details; this string is only the visible heading. */
export function toastPresentation(message: string, tone: AppToast["tone"]) {
  if (tone !== "error") return { summary: message, hint: null };
  const compatibility = COMPATIBILITY_PATCH.exec(message);
  if (compatibility) {
    const source = compatibility[1].split("/").at(-1) ?? compatibility[1];
    return {
      summary: `Couldn't save the clip edit in ${source}.`,
      hint: "Reload the preview, then try again.",
    };
  }
  return { summary: conciseLine(message) || "The edit failed.", hint: null };
}
