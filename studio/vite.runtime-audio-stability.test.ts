import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { stabilizeStandalonePreviewRuntime } from "./vite.runtime-audio-stability";

const require = createRequire(import.meta.url);

describe("standalone preview timeline audio stability", () => {
  it("stabilizes playback without decoder-reset seeks on play or pause", () => {
    const publishedRuntime =
      'e.mediaForceSyncNextTick=!0,ks(c.now()),next();' +
      'e.mediaForceSyncNextTick=!0,ks(e.currentTime);let d=e.capturedTimeline;' +
      'let k=r.tagName==="VIDEO"&&!r.paused,V=C!==void 0&&Math.abs(A-C)<.004,Q=!1;if(!k&&!oe&&!N&&V&&S>M){' +
      'let G=!k&&e.forceSync&&S>.02;';

    const stabilized = stabilizeStandalonePreviewRuntime(publishedRuntime);

    expect(stabilized).toContain('if(r.paused&&!oe&&!N&&V&&S>M){');
    expect(stabilized).not.toContain('if(!k&&!oe&&!N&&V&&S>M){');
    expect(stabilized).not.toContain("ks(c.now())");
    expect(stabilized).not.toContain("ks(e.currentTime)");
    expect(stabilized).toContain("e.mediaForceSyncNextTick=!0,next()");
    expect(stabilized).toContain(
      "e.mediaForceSyncNextTick=!0;let d=e.capturedTimeline",
    );
    expect(stabilized).toContain(
      'let G=!k&&!(r.tagName==="VIDEO"&&e.playing&&r.paused)&&e.forceSync&&S>.02;',
    );
  });

  it("fails closed when the installed runtime no longer matches the audited sync code", () => {
    expect(() => stabilizeStandalonePreviewRuntime("unrelated runtime source")).toThrow(
      /audio drift synchronization guard/i,
    );
  });

  it("patches exactly one synchronization guard", () => {
    const playReseek = "e.mediaForceSyncNextTick=!0,ks(c.now()),";
    const pauseReseek = "e.mediaForceSyncNextTick=!0,ks(e.currentTime);";
    const driftGuard = 'if(!k&&!oe&&!N&&V&&S>M){';
    expect(() =>
      stabilizeStandalonePreviewRuntime(
        `${playReseek}${pauseReseek}${driftGuard}${driftGuard}`,
      ),
    ).toThrow(
      /exactly once/i,
    );
  });

  it.each([
    ["play", "e.mediaForceSyncNextTick=!0,ks(c.now()),"],
    ["pause", "e.mediaForceSyncNextTick=!0,ks(e.currentTime);"],
  ] as const)("fails closed when the installed runtime loses its %s transition guard", (_, omitted) => {
    const runtime =
      "e.mediaForceSyncNextTick=!0,ks(c.now())," +
      "e.mediaForceSyncNextTick=!0,ks(e.currentTime);" +
      'if(!k&&!oe&&!N&&V&&S>M){' +
      'let G=!k&&e.forceSync&&S>.02;';

    expect(() => stabilizeStandalonePreviewRuntime(runtime.replace(omitted, ""))).toThrow(
      /transition.*not found/i,
    );
  });

  it("fails closed when the installed runtime loses its starting-video force-sync guard", () => {
    const runtime =
      "e.mediaForceSyncNextTick=!0,ks(c.now())," +
      "e.mediaForceSyncNextTick=!0,ks(e.currentTime);" +
      'if(!k&&!oe&&!N&&V&&S>M){';

    expect(() => stabilizeStandalonePreviewRuntime(runtime)).toThrow(
      /starting-video.*not found/i,
    );
  });

  it("recognizes and stabilizes the installed preview runtime", () => {
    const runtime = readFileSync(require.resolve("@hyperframes/core/runtime"), "utf8");
    const stabilized = stabilizeStandalonePreviewRuntime(runtime);

    expect(stabilized).toContain('if(r.paused&&!oe&&!N&&V&&S>M){');
    expect(stabilized).not.toContain("ks(c.now())");
    expect(stabilized).not.toContain("ks(e.currentTime)");
    expect(stabilized).toContain(
      '!(r.tagName==="VIDEO"&&e.playing&&r.paused)&&e.forceSync&&S>.02',
    );
    // Hard/catastrophic drift and explicit one-shot force synchronization stay
    // in the runtime; only the repeating strict sampler is narrowed.
    expect(stabilized).toContain("S>.5&&(N||I||W)");
    expect(stabilized).toContain("e.forceSync&&S>.02");
  });
});
