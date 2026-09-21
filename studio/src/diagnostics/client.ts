import { diagnosticRoute, redactDiagnostic } from "../../diagnostics/redact";
import { installInteractionCapture } from "./interactions";

type ClientEvent = { event: string; data: unknown; level: "info" | "warn" | "error"; clientTime: string; clientElapsedMs: number; clientSeq: number; rendererId: string };
export interface DiagnosticStatus { recording: boolean; sessionId: string; localOnly: boolean; retentionDays: number; maxLogBytes: number }
let initialized = false, enabled = false, clientSeq = 0, dropped = 0;
let queue: ClientEvent[] = [];
let sending: Promise<void> | null = null;
let transport: typeof fetch | null = null;
let rendererId = "";
const ROOT = "/api/diagnostics";
const MAX_BATCH = 16;

export function diagnosticsEnabled(): boolean { return initialized && enabled; }
export function recordLocalDiagnostic(event: string, data: unknown = {}, level: ClientEvent["level"] = "info"): void {
  if (!initialized || !enabled) return;
  try {
    if (queue.length >= 200) { dropped++; return; }
    queue.push({ event, data: redactDiagnostic(data), level, clientTime: new Date().toISOString(), clientElapsedMs: Math.round(performance.now()), clientSeq: ++clientSeq, rendererId });
    if (level === "error") void flushLocalDiagnostics();
  } catch { /* never interfere with the editor */ }
}

export async function getDiagnosticStatus(): Promise<DiagnosticStatus | null> {
  try {
    const response = await (transport ?? fetch)(`${ROOT}/status`, { signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

export function flushLocalDiagnostics(): Promise<void> {
  if (sending) return sending;
  if (!transport || !enabled || !queue.length) return Promise.resolve();
  sending = (async () => {
    // Fixed-size batches bound both memory and time. Failed batches are not
    // replayed (a timed-out response may already have been persisted).
    while (queue.length) {
      const events = queue.splice(0, MAX_BATCH);
      try {
        const response = await transport!(`${ROOT}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events, dropped }), signal: AbortSignal.timeout(3000) });
        if (!response.ok) { dropped += events.length; break; }
        dropped = 0;
      } catch { dropped += events.length; break; }
    }
  })().finally(() => { sending = null; });
  return sending;
}

export async function downloadDiagnostics(): Promise<void> {
  await flushLocalDiagnostics();
  const response = await (transport ?? fetch)(`${ROOT}/export`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("The diagnostic report could not be saved. Check available disk space and try again.");
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `MpVFX-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json.gz`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export function initializeLocalDiagnostics(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  // Hold a small initial queue while proving that this is our desktop server.
  enabled = true;
  rendererId = crypto.randomUUID();
  transport = window.fetch.bind(window);
  void getDiagnosticStatus().then((status) => {
    enabled = status?.recording === true;
    if (!enabled) queue = [];
    else void flushLocalDiagnostics();
  });
  installInteractionCapture(window, (event, data) => recordLocalDiagnostic(event, data));
  recordLocalDiagnostic("renderer.start", { viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio }, language: navigator.language });
  window.addEventListener("error", (event) => {
    recordLocalDiagnostic("renderer.error", { message: event.message, error: event.error, line: event.lineno, column: event.colno, resourceTag: event.target instanceof Element ? event.target.tagName : undefined }, "error");
  }, true);
  window.addEventListener("unhandledrejection", (event) => recordLocalDiagnostic("renderer.unhandled_rejection", { error: event.reason }, "error"));
  for (const event of ["online", "offline", "focus", "blur"]) window.addEventListener(event, () => recordLocalDiagnostic(`renderer.${event}`));
  document.addEventListener("visibilitychange", () => { recordLocalDiagnostic("renderer.visibility", { state: document.visibilityState }); void flushLocalDiagnostics(); });

  // Preview documents are separate JS realms; capture their errors as well.
  const attached = new WeakSet<Document>();
  const attachPreview = (frame: HTMLIFrameElement) => {
    try {
      const doc = frame.contentDocument, win = frame.contentWindow;
      if (!doc || !win || attached.has(doc)) return;
      attached.add(doc);
      win.addEventListener("error", (event) => recordLocalDiagnostic("preview.error", { message: event.message, error: event.error, line: event.lineno, column: event.colno }, "error"), true);
      win.addEventListener("unhandledrejection", (event) => recordLocalDiagnostic("preview.unhandled_rejection", { error: event.reason }, "error"));
      recordLocalDiagnostic("preview.loaded");
    } catch { /* cross-origin previews are deliberately inaccessible */ }
  };
  document.addEventListener("load", (event) => { if (event.target instanceof HTMLIFrameElement) attachPreview(event.target); }, true);

  const originalFetch = window.fetch;
  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const input = args[0];
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const start = performance.now();
    const method = args[1]?.method ?? (input instanceof Request ? input.method : "GET");
    // Observe local operations; never include URL queries, request/response data.
    const observe = url.includes("/api/") && !url.includes(ROOT);
    try {
      const response = await Reflect.apply(originalFetch, window, args);
      const durationMs = Math.round(performance.now() - start);
      if (observe && (!response.ok || durationMs > 1000 || method !== "GET")) recordLocalDiagnostic("request.finished", { route: diagnosticRoute(url), requestId: response.headers.get("X-MpVFX-Request-Id"), method, status: response.status, durationMs }, response.ok ? "info" : "warn");
      return response;
    } catch (error) {
      if (observe) recordLocalDiagnostic("request.failed", { route: diagnosticRoute(url), method, durationMs: Math.round(performance.now() - start), error }, "error");
      throw error;
    }
  };
  let longTasks = 0, longestTaskMs = 0;
  try {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) { longTasks++; longestTaskMs = Math.max(longestTaskMs, entry.duration); } }).observe({ type: "longtask", buffered: true });
  } catch { /* not supported by every embedded browser */ }
  let lastBeat = performance.now();
  setInterval(() => {
    const now = performance.now();
    recordLocalDiagnostic("renderer.heartbeat", { visibility: document.visibilityState, eventLoopDelayMs: Math.max(0, Math.round(now - lastBeat - 10_000)), longTasks, longestTaskMs: Math.round(longestTaskMs) });
    lastBeat = now; longTasks = 0; longestTaskMs = 0;
  }, 10_000);
  setInterval(() => void flushLocalDiagnostics(), 500);
  window.addEventListener("pagehide", () => {
    recordLocalDiagnostic("renderer.pagehide");
    // Beacon's total quota is limited; leave an explicit loss counter on failure.
    const events = queue.splice(0, MAX_BATCH);
    if (!events.length) return;
    try { navigator.sendBeacon(`${ROOT}/events`, new Blob([JSON.stringify({ events, dropped: dropped + queue.length })], { type: "application/json" })); } catch { /* abrupt shutdown still has disk breadcrumbs */ }
  });
}
