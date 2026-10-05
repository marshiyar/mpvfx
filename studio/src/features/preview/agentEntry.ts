import { projectIdFromPreviewHost } from "../../../shared/desktopPreviewOrigin";
import { installPreviewAgent } from "./agent";

// This bundle is appended only to authored preview HTML. Keep a second guard
// so a packaging mistake cannot install it into editor, thumbnail, or export.
if (location.protocol === "mpvfx:" && projectIdFromPreviewHost(location.host) !== null) {
  const compositionMatch = /^\/api\/projects\/[^/]+\/preview\/comp\/(.+)$/.exec(location.pathname);
  let compositionPath = "index.html";
  if (compositionMatch) {
    try { compositionPath = decodeURIComponent(compositionMatch[1]); } catch { /* Keep the safe default. */ }
  }
  installPreviewAgent(window, document, { parentOrigin: "mpvfx://editor", compositionPath });
}
