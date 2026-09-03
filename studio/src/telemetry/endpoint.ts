export interface TelemetryEndpoint {
  host: string;
  apiKey: string;
}

/**
 * Official MpVFX builds do not configure analytics. A distributor may opt in
 * only by providing both an HTTPS ingest host and its own write-only key.
 */
export function configuredTelemetryEndpoint(): TelemetryEndpoint | null {
  try {
    const hostValue = import.meta.env.VITE_MPVFX_TELEMETRY_HOST?.trim();
    const apiKey = import.meta.env.VITE_MPVFX_TELEMETRY_KEY?.trim();
    if (!hostValue || !apiKey) return null;

    const url = new URL(hostValue);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }

    return {
      host: `${url.origin}${url.pathname.replace(/\/+$/u, "")}`,
      apiKey,
    };
  } catch {
    return null;
  }
}
