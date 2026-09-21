import type { IncomingMessage, ServerResponse } from "node:http";
import type { Diagnostics } from "./logger";

export async function handleDiagnosticRequest(request: IncomingMessage, response: ServerResponse, log: Diagnostics): Promise<boolean> {
  const route = new URL(request.url ?? "/", "http://local").pathname;
  if (!route.startsWith("/api/diagnostics")) return false;
  const json = (status: number, body: unknown) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(body)); };
  if (route === "/api/diagnostics/status" && request.method === "GET") { json(200, log.status()); return true; }
  if (route === "/api/diagnostics/export" && request.method === "GET") {
    try {
      const report = await log.exportBundle();
      response.writeHead(200, { "Content-Type": "application/gzip", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="MpVFX-diagnostics-${log.sessionId}.json.gz"`, "Content-Length": report.length, "X-Content-Type-Options": "nosniff" });
      response.end(report);
    } catch { json(503, { error: "Local diagnostics are unavailable" }); }
    return true;
  }
  if (route === "/api/diagnostics/events" && request.method === "POST") {
    if (!request.headers["content-type"]?.startsWith("application/json")) { json(415, { error: "JSON required" }); return true; }
    try {
      const parts: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 512 * 1024) { json(413, { error: "Diagnostic batch too large" }); return true; }
        parts.push(Buffer.from(chunk));
      }
      const payload = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (!Array.isArray(payload.events) || payload.events.length > 32) { json(400, { error: "Invalid event batch" }); return true; }
      for (const entry of payload.events) {
        if (!entry || typeof entry.event !== "string" || !/^[a-z][a-z0-9_.:-]{0,99}$/i.test(entry.event)) continue;
        // Prefix marks renderer-originated evidence. It cannot impersonate a
        // native crash or override the server's session id, sequence or time.
        log.record(`client.${entry.event}`.slice(0, 100), {
          rendererId: typeof entry.rendererId === "string" && /^[a-f0-9-]{36}$/.test(entry.rendererId) ? entry.rendererId : undefined,
          clientSeq: Number.isSafeInteger(entry.clientSeq) ? entry.clientSeq : undefined,
          clientTime: typeof entry.clientTime === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(entry.clientTime) ? entry.clientTime : undefined,
          clientElapsedMs: typeof entry.clientElapsedMs === "number" ? entry.clientElapsedMs : undefined,
          detail: entry.data,
        }, entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info");
      }
      if (Number.isSafeInteger(payload.dropped) && payload.dropped > 0) log.record("client.events_lost", { count: payload.dropped }, "warn");
      if (!log.status().recording) json(503, { error: "Local diagnostics are unavailable" });
      else { log.flush(); json(200, { accepted: payload.events.length }); }
    } catch { if (!response.headersSent) json(400, { error: "Invalid diagnostic batch" }); }
    return true;
  }
  json(404, { error: "Unknown diagnostic operation" });
  return true;
}
