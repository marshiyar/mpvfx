import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

/** Generated-media idle check shared by native diagnostics on every CI OS. */
export async function verifyIdleRendererMemory(page, outputPath) {
  await page.waitForSelector("pierce/iframe");
  // Let the asset thumbnail decode before taking the retained-heap baseline.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const session = await page.createCDPSession();
  const samples = [];
  const started = Date.now();
  try {
    for (let index = 0; index <= 6; index++) {
      await session.send("HeapProfiler.collectGarbage");
      samples.push({
        elapsedMs: Date.now() - started,
        heap: await session.send("Runtime.getHeapUsage"),
        dom: await session.send("Memory.getDOMCounters"),
      });
      if (index < 6) await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    const retainedGrowthBytes = samples.at(-1).heap.usedSize - samples[0].heap.usedSize;
    const result = { platform: process.platform, architecture: process.arch, retainedGrowthBytes, samples };
    writeFileSync(outputPath, JSON.stringify(result, null, 2));
    // The thumbnail error loop retained hundreds of MB within this interval.
    // Allow normal editor/cache warm-up without accepting that unbounded growth.
    assert.ok(retainedGrowthBytes < 32 * 1024 * 1024, `Idle renderer retained ${Math.round(retainedGrowthBytes / 1024 / 1024)} MiB`);
    console.log(`DIAGNOSTICS_CHECK idle retained heap growth ${Math.round(retainedGrowthBytes / 1024)} KiB over 90 seconds`);
    return result;
  } finally {
    await session.detach();
  }
}
