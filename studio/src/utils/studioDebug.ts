// Opt-in diagnostic channels — one per question worth tracing, all off by
// default. Turn one on for the session with `localStorage.setItem("hf-<name>-debug",
// "1")` and reload, then grep the console for `[hf-<name>]`.
// Live channels: reload, select, drag, resize, commit.
//
// These exist because the interesting failures here are decisions, not crashes:
// a preview that reloads when it should not, a shift-click that selects nothing.
// Nothing is thrown and nothing is logged by default, so without a trace of the
// decision the only way to find the cause is to guess.
import { diagnosticsEnabled, recordLocalDiagnostic } from "../diagnostics/client";
type DebugDetails = Record<string, unknown> | (() => Record<string, unknown> | null);
type DebugLogger = (stage: string, data?: DebugDetails) => void;

export function makeStudioDebugLogger(name: string): DebugLogger {
  let enabled: boolean | null = null;
  let lastRecorded = 0;
  let sampledOut = 0;
  return (stage, data = {}) => {
    if (enabled === null) {
      try {
        enabled = localStorage.getItem(`hf-${name}-debug`) === "1";
      } catch {
        enabled = false;
      }
    }
    const local = diagnosticsEnabled();
    if (!enabled && !local) return;
    const now = performance.now();
    // Pointer movement channels can run at display refresh rate. Keep their
    // decision trail bounded while retaining every commit/reload decision.
    const throttled = local && /move|update|frame|tick/i.test(stage) && now - lastRecorded < 100;
    if (throttled) sampledOut++;
    if (!enabled && throttled) return;
    let details: Record<string, unknown> | null;
    try { details = typeof data === "function" ? data() : data; } catch { return; }
    if (!details) return;
    if (local && !throttled) { recordLocalDiagnostic(`decision.${name}`, { stage, sampledOut, ...details }); lastRecorded = now; sampledOut = 0; }
    if (!enabled) return;
    console.log(
      `[hf-${name}] ${JSON.stringify({ stage, t: Math.round(performance.now()), ...details })}`,
    );
  };
}
