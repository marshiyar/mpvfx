import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureProjectProvenance,
  projectProvenance,
  resetProjectProvenance,
} from "./projectProvenance";

beforeEach(() => {
  resetProjectProvenance();
});

describe("captureProjectProvenance", () => {
  it("records only aggregate project size", () => {
    captureProjectProvenance(
      "p1",
      ["index.html", "a.html", "assets/clip.mp4", "assets/vo.wav", "assets/logo.png"],
      ["index.html", "a.html"],
    );

    expect(projectProvenance()).toEqual({
      project_composition_count: 2,
      project_media_count: 3,
      project_file_count: 5,
    });
  });

  it("does not read project files or retain their names", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    captureProjectProvenance(
      "secret-project",
      ["workflow.json", "assets/unreleased-product-hero.mp4"],
      ["launch.html"],
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(projectProvenance())).not.toMatch(/secret|unreleased|launch|workflow/i);
    vi.unstubAllGlobals();
  });
});
