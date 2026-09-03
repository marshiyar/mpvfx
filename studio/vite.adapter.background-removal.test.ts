import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createProjectSignatureCache,
  createStandaloneAdapter,
  type StandaloneAdapterHost,
} from "./vite.adapter";

describe("standalone background-removal runtime", () => {
  it("uses the packaged local renderer without loading source from a sibling monorepo", async () => {
    const loadModule = vi.fn(async () => {
      throw new Error("no external source modules are available");
    });
    const renderBackgroundRemoval = vi.fn(async () => ({
      provider: "CPU",
      framesProcessed: 1,
      durationSeconds: 0.01,
      avgMsPerFrame: 10,
    }));
    const host = {
      studioDir: resolve("/Applications/MpVFX.app/Contents/Resources/app.asar"),
      loadModule,
      renderBackgroundRemoval,
    } as StandaloneAdapterHost & {
      renderBackgroundRemoval: typeof renderBackgroundRemoval;
    };
    const adapter = createStandaloneAdapter(
      resolve("/user-data/projects"),
      host,
      createProjectSignatureCache({ compute: () => "signature" }),
    );

    const state = adapter.startBackgroundRemoval!({
      project: { id: "demo", dir: resolve("/user-data/projects/demo") },
      inputPath: resolve("/user-data/projects/demo/assets/source.mp4"),
      inputAssetPath: "assets/source.mp4",
      outputPath: resolve("/user-data/projects/demo/assets/source-cutout.webm"),
      outputAssetPath: "assets/source-cutout.webm",
      quality: "balanced",
      device: "auto",
      jobId: "cutout-1",
    });
    await vi.waitFor(() => expect(state.status).toBe("complete"));

    expect(renderBackgroundRemoval).toHaveBeenCalledOnce();
    expect(loadModule).not.toHaveBeenCalled();
  });
});
