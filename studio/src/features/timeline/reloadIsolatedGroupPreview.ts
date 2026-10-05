/** A source commit changes the bus markup; the isolated frame must reload to see it. */
export function reloadIsolatedGroupPreview(
  iframe: HTMLIFrameElement | null,
  reload?: () => void,
): void {
  if (!iframe || !reload) return;
  try { if (iframe.contentDocument) return; } catch { /* Isolated preview. */ }
  reload();
}
