import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { diagnosticContext, recordDiagnostic, withDiagnosticContext } from "./context";

/** Install before loading producer/engine modules. Do not consume pipes or change error handling. */
export function installProcessDiagnostics(): () => void {
  const originalSpawn = childProcess.spawn;
  const originalExecSync = childProcess.execSync;
  const originalExecFileSync = childProcess.execFileSync;
  const originalSpawnSync = childProcess.spawnSync;
  let nextId = 0;
  const executableName = (command: unknown) => typeof command === "string" ? command.split(/[\\/]/).pop()?.split(/\s/)[0]?.slice(0, 80) : "unknown";

  // Wrapping the process emitter observes lifecycle without adding an `error`
  // listener (which would otherwise swallow previously-fatal unhandled errors).
  function observe(child: ChildProcess, command: unknown, options: any, started: number) {
    const context = diagnosticContext();
    const processId = ++nextId;
    let stderrTail = "", stderrBytes = 0, lastSample = 0;
    const details = { processId, pid: child.pid, executable: executableName(command), windowsHide: options?.windowsHide ?? null, detached: options?.detached ?? null, shell: Boolean(options?.shell) };
    const record = (event: string, data: unknown, level: "info" | "warn" | "error" = "info") => withDiagnosticContext(context, () => recordDiagnostic(event, data, level));
    record("process.start", details);
    if (child.stderr) {
      const stream = child.stderr;
      const originalEmit = stream.emit;
      stream.emit = function (event: string | symbol, ...args: any[]) {
        if (event === "data") {
          try {
            const text = String(args[0]);
            stderrBytes += Buffer.byteLength(text);
            stderrTail = (stderrTail + text).slice(-8192);
            // A live warning is useful if a helper never exits. Always save the
            // bounded tail again on close. No stdout: it can contain media/JSON.
            if (/error|fatal|failed|warning/i.test(text) && performance.now() - lastSample > 1000) {
              lastSample = performance.now();
              record("process.stderr", { processId, pid: child.pid, message: text.slice(-2048) }, "warn");
            }
          } catch { /* inspection never changes stream behavior */ }
        }
        return Reflect.apply(originalEmit, this, [event, ...args]);
      };
    }
    const originalEmit = child.emit;
    child.emit = function (event: string | symbol, ...args: any[]) {
      if (event === "error") {
        // Node's error.message often embeds the complete command. Only its
        // structured code is safe here; command arguments are never collected.
        const error = args[0];
        record("process.error", { ...details, errorName: error?.name, code: error?.code, errno: error?.errno }, "error");
      }
      if (event === "close") record("process.exit", { ...details, code: args[0], signal: args[1], durationMs: Math.round(performance.now() - started), stderrBytes, stderrTail, stderrTruncated: stderrBytes > 8192 }, args[0] === 0 ? "info" : "error");
      return Reflect.apply(originalEmit, this, [event, ...args]);
    };
    return child;
  }

  childProcess.spawn = function (...args: any[]) {
    const started = performance.now();
    try {
      const child = Reflect.apply(originalSpawn, childProcess, args);
      return observe(child, args[0], Array.isArray(args[1]) ? args[2] : args[1], started);
    } catch (error: any) {
      recordDiagnostic("process.spawn_failed", { executable: executableName(args[0]), code: error?.code }, "error");
      throw error;
    }
  } as typeof childProcess.spawn;

  function wrapSync(original: (...args: any[]) => any, commandIsShell: boolean) {
    return function (...args: any[]) {
      const started = performance.now();
      const details = { executable: commandIsShell ? "shell" : executableName(args[0]), synchronous: true };
      recordDiagnostic("process.sync_start", details);
      try {
        const result = Reflect.apply(original, childProcess, args);
        recordDiagnostic("process.sync_exit", { ...details, durationMs: Math.round(performance.now() - started), code: result?.status ?? 0, signal: result?.signal, stderrTail: result?.stderr ? String(result.stderr).slice(-2048) : undefined }, result?.error || result?.status ? "warn" : "info");
        return result;
      } catch (error: any) {
        recordDiagnostic("process.sync_exit", { ...details, durationMs: Math.round(performance.now() - started), code: error?.status ?? error?.code, signal: error?.signal, stderrTail: error?.stderr ? String(error.stderr).slice(-2048) : undefined }, "error");
        throw error;
      }
    };
  }
  childProcess.execSync = wrapSync(originalExecSync, true) as typeof childProcess.execSync;
  childProcess.execFileSync = wrapSync(originalExecFileSync, false) as typeof childProcess.execFileSync;
  childProcess.spawnSync = wrapSync(originalSpawnSync, false) as typeof childProcess.spawnSync;
  syncBuiltinESMExports();
  return () => {
    childProcess.spawn = originalSpawn;
    childProcess.execSync = originalExecSync;
    childProcess.execFileSync = originalExecFileSync;
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  };
}
