import { describe, expect, it } from "vitest";
import { matchRenderHeartbeatRequest } from "./vite.render-heartbeat";

describe("render heartbeat route", () => {
  it("accepts only POST heartbeats and safely decodes the job id", () => {
    expect(matchRenderHeartbeatRequest("POST", "/render/job%20one/heartbeat")).toBe("job one");
    expect(matchRenderHeartbeatRequest("GET", "/render/job%20one/heartbeat")).toBeNull();
  });

  it("does not steal cancel, progress, nested, or malformed API routes", () => {
    expect(matchRenderHeartbeatRequest("POST", "/render/job/cancel")).toBeNull();
    expect(matchRenderHeartbeatRequest("POST", "/render/job/progress")).toBeNull();
    expect(matchRenderHeartbeatRequest("POST", "/render/a/b/heartbeat")).toBeNull();
    expect(matchRenderHeartbeatRequest("POST", "/render/%E0%A4%A/heartbeat")).toBeNull();
  });
});
