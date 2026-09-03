// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/feedback/projectProvenance", () => ({
  captureProjectProvenance: vi.fn(),
}));

import { useFileTree } from "./useFileTree";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("file tree composition refresh", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refreshes the reusable composition list as well as ordinary files", async () => {
    let listing = {
      files: ["index.html", "compositions/intro.html"],
      compositions: ["index.html", "compositions/intro.html"],
      dir: "/projects/demo",
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(listing)));

    const captured: { current: ReturnType<typeof useFileTree> | null } = { current: null };
    const projectIdRef = { current: "demo" };
    function Probe(): null {
      captured.current = useFileTree({ projectId: "demo", projectIdRef });
      return null;
    }

    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() =>
      expect(captured.current?.compositions).toEqual([
        "index.html",
        "compositions/intro.html",
      ]),
    );

    listing = {
      files: ["index.html"],
      compositions: ["index.html"],
      dir: "/projects/demo",
    };
    await act(async () => captured.current?.refreshFileTree());

    expect(captured.current?.compositions).toEqual(["index.html"]);
    await act(async () => root.unmount());
  });
});
