/** A distinct, deterministic origin for each project's authored documents. */
export function previewOriginForProject(projectId: string): string {
  if (!projectId) throw new Error("Invalid preview project ID");
  const encoded = encodeURIComponent(projectId);
  let hex = "";
  for (let index = 0; index < encoded.length; index++) {
    const byte = encoded[index] === "%"
      ? Number.parseInt(encoded.slice(index + 1, index + 3), 16)
      : encoded.charCodeAt(index);
    if (encoded[index] === "%") index += 2;
    hex += byte.toString(16).padStart(2, "0");
  }
  // DNS labels have a 63-character limit. Keep byte pairs together so the
  // host can be decoded without a table shared with the renderer.
  const labels = hex.match(/.{1,60}/g);
  if (!labels) throw new Error("Invalid preview project ID");
  return `mpvfx://${labels.join(".")}.preview`;
}

/** Returns null for noncanonical or malformed preview hosts. */
export function projectIdFromPreviewHost(host: string): string | null {
  if (!host.endsWith(".preview")) return null;
  const labels = host.slice(0, -".preview".length).split(".");
  if (!labels.length || labels.some(label => !/^(?:[0-9a-f]{2}){1,30}$/.test(label))) return null;
  const hex = labels.join("");
  try {
    const id = decodeURIComponent(hex.match(/../g)!.map(pair => `%${pair}`).join(""));
    return previewOriginForProject(id) === `mpvfx://${host}` ? id : null;
  } catch { return null; }
}
