import { describe, expect, it, vi } from "vitest";
import { prepareEditorRendererSession } from "./rendererCache";

describe("desktop renderer cache policy", () => {
  it("clears legacy HTTP and JavaScript caches before loading the editor", async () => {
    const rendererSession = {
      clearCache: vi.fn(async () => {}),
      clearCodeCaches: vi.fn(async () => {}),
    };

    await prepareEditorRendererSession(rendererSession);

    expect(rendererSession.clearCache).toHaveBeenCalledOnce();
    expect(rendererSession.clearCodeCaches).toHaveBeenCalledOnce();
    expect(rendererSession.clearCodeCaches).toHaveBeenCalledWith({});
  });

  it("does not load with only one of the two stale caches cleared", async () => {
    const rendererSession = {
      clearCache: vi.fn(async () => {}),
      clearCodeCaches: vi.fn(async () => {
        throw new Error("code cache locked");
      }),
    };

    await expect(prepareEditorRendererSession(rendererSession)).rejects.toThrow(
      "code cache locked",
    );
    expect(rendererSession.clearCache).toHaveBeenCalledOnce();
    expect(rendererSession.clearCodeCaches).toHaveBeenCalledOnce();
  });
});
