import { AsyncLocalStorage } from "node:async_hooks";

export type DiagnosticLevel = "info" | "warn" | "error" | "fatal";
export type DiagnosticContext = { jobId?: string; requestId?: string };
export interface DiagnosticSink {
  record(event: string, data?: unknown, level?: DiagnosticLevel, context?: DiagnosticContext): void;
}
const context = new AsyncLocalStorage<DiagnosticContext>();
let sink: DiagnosticSink | undefined;

export function installDiagnosticSink(next: DiagnosticSink): () => void {
  const previous = sink;
  sink = next;
  return () => { if (sink === next) sink = previous; };
}
export function diagnosticContext(): DiagnosticContext { return context.getStore() ?? {}; }
export function withDiagnosticContext<T>(value: DiagnosticContext, work: () => T): T {
  return context.run({ ...diagnosticContext(), ...value }, work);
}
export function recordDiagnostic(event: string, data?: unknown, level: DiagnosticLevel = "info"): void {
  try { sink?.record(event, data, level, diagnosticContext()); } catch { /* observability cannot interrupt editing */ }
}
