import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveInstalledProducerEntry } from "./vite.producer";

function installedProducerBundle(): string {
  const entry = resolveInstalledProducerEntry(process.cwd());
  if (!entry) throw new Error("Installed Producer bundle is unavailable");
  return readFileSync(entry, "utf8");
}

describe("installed Producer capture geometry", () => {
  it("keeps the macOS full-surface screenshot guard for fitting video canvases", () => {
    const source = installedProducerBundle();
    const downgradeLog =
      'logInitPhase("captureBeyondViewport downgraded: page content fits the capture viewport")';
    const downgradeLogIndex = source.indexOf(downgradeLog);

    expect(downgradeLogIndex).toBeGreaterThan(-1);

    const downgradeBlock = source.slice(
      Math.max(0, downgradeLogIndex - 600),
      downgradeLogIndex + downgradeLog.length + 100,
    );

    // A fitting fixed-size canvas still needs full-surface capture on regular
    // macOS Chrome: viewport-bound CDP screenshots can expose a compositor
    // surface shorter than the requested canvas and shave the bottom rows.
    expect(downgradeBlock).toMatch(
      /if \(!needsBeyondViewport\s*&&\s*!shouldDefaultCaptureBeyondViewport\(await session\.browser\.version\(\)\)\)/,
    );
  });
});
