import childProcess from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { installProcessDiagnostics } from "./processes";
import { installDiagnosticSink, withDiagnosticContext } from "./context";

describe("helper process diagnostics", () => {
  it("observes actual exit and stderr without consuming stdout or changing spawn options", async () => {
    const events: any[] = [];
    const restoreSink = installDiagnosticSink({ record: (event, data, level, context) => events.push({ event, data, level, context }) });
    const restore = installProcessDiagnostics();
    try {
      const child = withDiagnosticContext({ jobId: "test-render" }, () => childProcess.spawn(process.execPath, ["-e", 'process.stdout.write("JSON_RESULT"); process.stderr.write("GPU diagnostic\\n"); process.exitCode=3'], { windowsHide: true, detached: false }));
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.resume();
      await once(child, "close");
      expect(stdout).toBe("JSON_RESULT");
      expect(events.find((e) => e.event === "process.start")).toMatchObject({ data: { windowsHide: true, detached: false }, context: { jobId: "test-render" } });
      expect(events.find((e) => e.event === "process.exit")).toMatchObject({ data: { code: 3, stderrTail: "GPU diagnostic\n" }, context: { jobId: "test-render" } });
      expect(JSON.stringify(events)).not.toContain("JSON_RESULT");
      expect(JSON.stringify(events)).not.toContain("process.stdout.write");
    } finally { restore(); restoreSink(); }
  });
  it("keeps synchronous helper failure semantics and does not log arguments", () => {
    const events: any[] = [];
    const restoreSink = installDiagnosticSink({ record: (event, data) => events.push({ event, data }) });
    const restore = installProcessDiagnostics();
    try {
      expect(() => childProcess.execFileSync(process.execPath, ["-e", "process.exit(7)"], { stdio: "pipe" })).toThrow();
      expect(events.find((e) => e.event === "process.sync_exit").data).toMatchObject({ code: 7 });
      expect(JSON.stringify(events)).not.toContain("process.exit(7)");
    } finally { restore(); restoreSink(); }
  });
  it("preserves promisified execFile's stdout/stderr result and child handle", async () => {
    const events: any[] = [];
    const restoreSink = installDiagnosticSink({ record: (event, data) => events.push({ event, data }) });
    const restore = installProcessDiagnostics();
    try {
      const operation = promisify(childProcess.execFile)(process.execPath, ["-e", 'process.stdout.write("json-output"); process.stderr.write("probe-warning")']);
      expect(operation.child).toBeDefined();
      await expect(operation).resolves.toEqual({ stdout: "json-output", stderr: "probe-warning" });
      expect(events.some((e) => e.event === "process.exit")).toBe(true);
      const failed = promisify(childProcess.execFile)(process.execPath, ["-e", 'process.stdout.write("partial");process.stderr.write("failure");process.exitCode=7']);
      await expect(failed).rejects.toMatchObject({ code: 7, stdout: "partial", stderr: "failure" });
    } finally { restore(); restoreSink(); }
  });
});
