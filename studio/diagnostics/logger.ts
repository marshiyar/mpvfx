import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import type { DiagnosticContext, DiagnosticLevel } from "./context";
import { redactDiagnostic } from "./redact";

const gzipAsync = promisify(gzip);
const LOG_FILE = /^session-[a-f0-9-]{36}-\d{5}\.jsonl$/;
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
    const entries = files();
    entries.forEach((entry, index) => {
      if (join(directory, entry.name) !== file() && (index < entries.length - maxFiles || entry.stat.mtimeMs < Date.now() - retentionDays * DAY)) unlinkSync(join(directory, entry.name));
    });
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(marker) && !lstatSync(marker).isSymbolicLink()) {
      const raw = JSON.parse(readFileSync(marker, "utf8"));
      previous = { previousSessionId: raw.sessionId, startedAt: raw.startedAt };
    }
    writeFileSync(marker, JSON.stringify({ sessionId, startedAt }), { mode: 0o600 });
    prune();
  } catch { failed = true; }

  function flush(durable = false): void {
    if (failed || closed || !pending.length) return;
    try {
      const batch = pending.splice(0);
      for (const line of batch) {
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > maxFileBytes) { part++; size = 0; }
        appendFileSync(file(), line, { mode: 0o600 });
        size += bytes;
      }
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
      if (++windowCount > 250 || pending.length > 250) { dropped++; return; }
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
    async exportBundle(): Promise<Buffer> {
      record("diagnostics.export_requested");
      flush();
      if (failed) throw new Error("Local diagnostics are unavailable; check disk space and permissions.");
      const events: unknown[] = [];
      let invalidLines = 0;
      for (const entry of files()) {
        // Only our bounded log files. Never collect arbitrary files, media or memory dumps.
        if (entry.stat.size > maxFileBytes + 128 * 1024) { invalidLines++; continue; }
        for (const line of readFileSync(join(directory, entry.name), "utf8").split("\n")) {
          if (!line) continue;
          try { events.push(JSON.parse(line)); } catch { invalidLines++; }
        }
      }
      events.sort((a: any, b: any) => a.time.localeCompare(b.time) || (a.sessionId === b.sessionId ? a.seq - b.seq : 0));
      return gzipAsync(JSON.stringify({
        schemaVersion: 1, product: "MpVFX", exportedAt: new Date().toISOString(), sessionId,
        retention: { maxFiles, maxFileBytes, retentionDays }, invalidLines,
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
