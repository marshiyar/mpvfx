import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import type { DiagnosticContext, DiagnosticLevel } from "./context";
import { redactDiagnostic } from "./redact";

const gzipAsync = promisify(gzip);
const LOG_FILE = /^session-[a-f0-9-]{36}-\d{5,12}\.jsonl$/;
const DAY = 86_400_000;
interface Options {
  directory: string;
  metadata: Record<string, unknown>;
  maxFileBytes?: number;
  maxFiles?: number;
  flushIntervalMs?: number;
}

export function createDiagnostics(options: Options) {
  const { directory } = options;
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 12;
  const retentionDays = 7;
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let metadata = redactDiagnostic(options.metadata);
  let seq = 0, part = 0, size = 0, dropped = 0, windowCount = 0, windowStart = Date.now();
  let pending: string[] = [];
  let failed = false, closed = false;
  let previous: unknown = null;
  const marker = join(directory, "active-session.json");
  const file = () => join(directory, `session-${sessionId}-${String(part).padStart(5, "0")}.jsonl`);

  function files() {
    return readdirSync(directory).filter((name) => LOG_FILE.test(name))
      .map((name) => ({ name, stat: lstatSync(join(directory, name)) }))
      .filter(({ stat }) => stat.isFile() && !stat.isSymbolicLink())
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.name.localeCompare(b.name));
  }
  function prune() {
    const entries = files().filter((entry) => join(directory, entry.name) !== file());
    const keep = maxFiles - (existsSync(file()) ? 1 : 0);
    entries.forEach((entry, index) => {
      if (index < entries.length - keep || entry.stat.mtimeMs < Date.now() - retentionDays * DAY) unlinkSync(join(directory, entry.name));
    });
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(marker) && !lstatSync(marker).isSymbolicLink()) {
      try {
        const raw = JSON.parse(readFileSync(marker, "utf8"));
        previous = { previousSessionId: raw.sessionId, startedAt: raw.startedAt };
      } catch { previous = { markerUnreadable: true }; }
    }
    writeFileSync(marker, JSON.stringify({ sessionId, startedAt }), { mode: 0o600 });
    prune();
  } catch { failed = true; }

  function flush(durable = false): void {
    if (failed || closed || !pending.length) return;
    try {
      const batch = pending.splice(0);
      let chunk = "";
      const beginFile = () => {
        chunk = JSON.stringify({ type: "diagnostic-file", schemaVersion: 1, sessionId, startedAt, metadata }) + "\n";
        size = Buffer.byteLength(chunk);
      };
      const append = () => { if (chunk) { appendFileSync(file(), chunk, { mode: 0o600 }); chunk = ""; } };
      for (const line of batch) {
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > maxFileBytes) { append(); part++; size = 0; }
        if (size === 0) beginFile();
        chunk += line;
        size += bytes;
      }
      append();
      prune();
      if (durable) { const fd = openSync(file(), "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
    } catch { failed = true; pending = []; }
  }
  function enqueue(event: string, data: unknown, level: DiagnosticLevel, context: DiagnosticContext) {
    pending.push(JSON.stringify({ schemaVersion: 1, sessionId, seq: ++seq, time: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), event, level, context: redactDiagnostic(context), data: redactDiagnostic(data) }) + "\n");
  }
  function record(event: string, data: unknown = {}, level: DiagnosticLevel = "info", context: DiagnosticContext = {}) {
    if (closed || failed) return;
    try {
      if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(event)) event = "diagnostics.invalid_event";
      if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); windowCount = 0; }
      if ((++windowCount > 250 || pending.length > 250) && level !== "fatal") { dropped++; return; }
      if (dropped) { enqueue("diagnostics.dropped", { count: dropped, reason: "rate_or_queue_limit" }, "warn", {}); dropped = 0; }
      enqueue(event, data, level, context);
      if (level === "error" || level === "fatal") flush(level === "fatal");
    } catch { /* malformed producer events must not affect the application */ }
  }
  record("session.start", { ...options.metadata, logging: { schemaVersion: 1, flushIntervalMs: options.flushIntervalMs ?? 500, retentionDays, maxFiles, maxFileBytes } });
  if (previous) record("session.previous_unclean_exit", previous, "warn");
  flush();
  const timer = setInterval(() => flush(), options.flushIntervalMs ?? 500);
  timer.unref();
  function status() { return { recording: !failed && !closed, sessionId, startedAt, dropped, localOnly: true, nativeDumpsIncluded: false, retentionDays, maxLogBytes: maxFiles * maxFileBytes }; }

  return {
    sessionId, directory, record, flush, status,
    updateMetadata(value: Record<string, unknown>) { metadata = redactDiagnostic({ ...(metadata as Record<string, unknown>), ...value }); },
    async exportBundle(): Promise<Buffer> {
      record("diagnostics.export_requested");
      flush();
      if (failed) throw new Error("Local diagnostics are unavailable; check disk space and permissions.");
      const events: unknown[] = [];
      const sessions: Record<string, unknown> = Object.create(null);
      sessions[sessionId] = { startedAt, metadata };
      let invalidLines = 0;
      const retainedFiles = files();
      for (const entry of retainedFiles) {
        // Only our bounded log files. Never collect arbitrary files, media or memory dumps.
        if (entry.stat.size > maxFileBytes + 128 * 1024) { invalidLines++; continue; }
        for (const line of readFileSync(join(directory, entry.name), "utf8").split("\n")) {
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed?.type === "diagnostic-file" && typeof parsed.sessionId === "string") {
              if (parsed.sessionId !== sessionId) sessions[parsed.sessionId] = { startedAt: parsed.startedAt, metadata: parsed.metadata };
            } else if (parsed && typeof parsed.sessionId === "string" && typeof parsed.event === "string" && typeof parsed.time === "string" && Number.isSafeInteger(parsed.seq)) events.push(parsed);
            else invalidLines++;
          } catch { invalidLines++; }
        }
      }
      // Wall clocks can be adjusted during a session. Sequence is authoritative
      // within it; never reorder that session's evidence by wall time.
      const sessionOrder = new Map<string, number>();
      for (const event of events as any[]) if (!sessionOrder.has(event.sessionId)) sessionOrder.set(event.sessionId, sessionOrder.size);
      events.sort((a: any, b: any) => (sessionOrder.get(a.sessionId)! - sessionOrder.get(b.sessionId)!) || a.seq - b.seq);
      return gzipAsync(JSON.stringify({
        schemaVersion: 1, product: "MpVFX", exportedAt: new Date().toISOString(), sessionId,
        sessions,
        retention: { maxFiles, maxFileBytes, retentionDays, rotated: retainedFiles.some(({ name }) => !name.endsWith("-00000.jsonl")) }, invalidLines,
        privacy: "Local diagnostic events only. No media, input values, environment variables, command arguments or native memory dumps. Paths, URLs and recognized credentials are redacted before writing.",
        interpretation: "Wall time orders sessions; elapsedMs/seq order events within a session. Client time is supplementary. Unclean exit alone does not prove a crash. Dropped-event counters and rotation indicate incomplete history.",
        events,
      }), { level: 6 });
    },
    close(clean = true): void {
      if (closed) return;
      clearInterval(timer);
      record("session.end", { clean });
      flush(true);
      if (clean && !failed) { try { unlinkSync(marker); } catch { /* leave an honest unclean marker if cleanup fails */ } }
      closed = true;
    },
  };
}

export type Diagnostics = ReturnType<typeof createDiagnostics>;
