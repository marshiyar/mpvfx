import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createDiagnostics } from "./logger";
import { redactDiagnostic } from "./redact";
import { installDiagnosticSink, recordDiagnostic, withDiagnosticContext } from "./context";

const roots: string[] = [];
const closers: Array<() => void> = [];
function logger(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mpvfx-diagnostics-test-"));
  roots.push(directory);
  const log = createDiagnostics({ directory, metadata: { platform: process.platform, build: "test" }, ...options });
  closers.push(() => log.close());
  return { log, directory };
}
afterEach(() => {
  closers.splice(0).forEach((close) => close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("local diagnostic evidence", () => {
  it("redacts credentials, content, paths, URLs and email before they reach disk", async () => {
    const { log, directory } = logger();
    log.record("export.failed", {
      password: "CANARY_PASSWORD", env: { PRIVATE_KEY: "CANARY_ENV" },
      inputValue: "CANARY_TYPED", html: "CANARY_MEDIA_CONTENT", args: ["CANARY_ARG"],
      projectName: "CANARY_PROJECT", filename: "CANARY_VIDEO.mov",
      message: "Failed C:\\Users\\CANARY_USER\\My Private Video.mov; /Users/CANARY_MAC/Secret.mp4; person@example.com token=CANARY_TOKEN " + ["https:/", "/user:CANARY_PASS", "@host/private?key=CANARY_QUERY"].join(""),
      error: new Error("GPU context failure"),
    }, "error");
    log.flush();
    const persisted = readdirSync(directory).filter((p) => p.endsWith(".jsonl")).map((p) => readFileSync(join(directory, p), "utf8")).join("");
    expect(persisted).not.toMatch(/CANARY_|person@example|user:|key=/);
    expect(persisted).toContain("GPU context failure");
    expect(JSON.stringify(redactDiagnostic({ self: (() => { const a: any = {}; a.a = a; return a; })() }))).toContain("circular");
  });

  it("correlates simultaneous jobs without attributing one job's errors to another", async () => {
    const { log } = logger();
    const restore = installDiagnosticSink(log);
    await Promise.all(["job-a", "job-b"].map((jobId) => withDiagnosticContext({ jobId }, async () => {
      await new Promise((resolve) => setTimeout(resolve, jobId === "job-a" ? 4 : 1));
      recordDiagnostic("helper.exit", { code: jobId === "job-a" ? 0 : 1 });
    })));
    restore();
    const report = JSON.parse(gunzipSync(await log.exportBundle()).toString());
    const events = report.events.filter((event: any) => event.event === "helper.exit");
    expect(events.map((event: any) => [event.context.jobId, event.data.code])).toEqual([["job-b", 1], ["job-a", 0]]);
    expect(new Set(events.map((event: any) => event.sessionId)).size).toBe(1);
    expect(events[1].seq).toBeGreaterThan(events[0].seq);
    expect(events[1].elapsedMs).toBeGreaterThanOrEqual(events[0].elapsedMs);
  });

  it("rotates and bounds retained logs, excludes arbitrary files and raw dumps from exports", async () => {
    const { log, directory } = logger({ maxFileBytes: 1200, maxFiles: 3 });
    writeFileSync(join(directory, "do-not-export.dmp"), "CANARY_DUMP");
    writeFileSync(join(directory, "personal.txt"), "CANARY_OTHER_FILE");
    for (let i = 0; i < 30; i++) { log.record("export.progress", { step: i, message: "x".repeat(300) }); log.flush(); }
    const files = readdirSync(directory).filter((p) => p.endsWith(".jsonl"));
    expect(files.length).toBeLessThanOrEqual(3);
    expect(files.every((p) => readFileSync(join(directory, p)).byteLength < 2200)).toBe(true);
    const reportText = gunzipSync(await log.exportBundle()).toString();
    const report = JSON.parse(reportText);
    expect(report.schemaVersion).toBe(1);
    expect(report.retention.maxFiles).toBe(3);
    expect(report.retention.rotated).toBe(true);
    expect(report.sessions[log.sessionId].metadata.build).toBe("test");
    expect(report.events.some((e: any) => e.data.step === 29)).toBe(true);
    expect(reportText).not.toContain("CANARY_");
  });

  it("distinguishes an unclean previous exit from a confirmed crash and a clean exit", async () => {
    const { log, directory } = logger();
    log.close();
    writeFileSync(join(directory, "active-session.json"), JSON.stringify({ sessionId: "interrupted-test", startedAt: "2026-09-20T00:00:00Z" }));
    const next = createDiagnostics({ directory, metadata: {} });
    closers.push(() => next.close());
    const report = JSON.parse(gunzipSync(await next.exportBundle()).toString());
    expect(report.events.find((e: any) => e.event === "session.previous_unclean_exit").data.previousSessionId).toBe("interrupted-test");
    expect(report.events.some((e: any) => e.event === "crash.native")).toBe(false);
    next.close();
    expect(readdirSync(directory)).not.toContain("active-session.json");
  });

  it("reports logging failure without throwing into the editor", async () => {
    const { log, directory } = logger();
    rmSync(directory, { recursive: true, force: true });
    expect(() => { log.record("export.failed", { message: "failure" }, "error"); log.flush(); }).not.toThrow();
    expect(log.status().recording).toBe(false);
    await expect(log.exportBundle()).rejects.toThrow(/diagnostic/i);
  });

  it("preserves a fatal crash even during an event flood and reports the lost events", async () => {
    const { log } = logger();
    for (let i = 0; i < 500; i++) log.record("ui.noisy", { i });
    log.record("electron.render_process_gone", { reason: "crashed" }, "fatal");
    expect(log.status().recording).toBe(true);
    const report = JSON.parse(gunzipSync(await log.exportBundle()).toString());
    expect(report.events.some((e: any) => e.event === "diagnostics.dropped" && e.data.count > 0)).toBe(true);
    expect(report.events.some((e: any) => e.event === "electron.render_process_gone" && e.level === "fatal")).toBe(true);
  });

  it("continues logging after an interrupted marker write", async () => {
    const { log, directory } = logger();
    log.close();
    writeFileSync(join(directory, "active-session.json"), "{truncated");
    const next = createDiagnostics({ directory, metadata: {} });
    closers.push(() => next.close());
    expect(next.status().recording).toBe(true);
    const report = JSON.parse(gunzipSync(await next.exportBundle()).toString());
    expect(report.events.some((e: any) => e.event === "session.previous_unclean_exit" && e.data.markerUnreadable)).toBe(true);
  });
});
