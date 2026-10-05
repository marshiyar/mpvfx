import { describe, expect, it } from "vitest";
import { previewOriginForProject, projectIdFromPreviewHost } from "../../shared/desktopPreviewOrigin";

describe("desktop preview origins", () => {
  it.each(["MpVFX", "Mañana demo", "Percent%20Name", "a".repeat(100)])(
    "round trips a project ID through its own host: %s", id => {
      const origin = previewOriginForProject(id);
      expect(projectIdFromPreviewHost(new URL(origin).host)).toBe(id);
    },
  );

  it("rejects malformed and cross-project hosts or paths", () => {
    for (const host of ["editor", "preview", "aa.preview.evil", "f.preview", "61.62.preview", "4142.PREVIEW"]) {
      expect(projectIdFromPreviewHost(host)).toBeNull();
    }
  });
});
