// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryView } from "../../../shared/library/library";
import { LibraryNavigator } from "./LibraryNavigator";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const library: LibraryView = {
  id: "library", name: "Film", path: "/Film.mpvfxlibrary",
  events: [{ id: "event-a", name: "First event" }, { id: "event-b", name: "Second event" }],
  projects: [
    { id: "project-a", eventId: "event-a", name: "First project", state: "ready" },
    { id: "project-b", eventId: "event-b", name: "Second project", state: "ready" },
  ],
  assets: [
    { id: "asset-a", eventId: "event-a", name: "First media", kind: "image", mode: "managed", state: "ready", available: true },
    { id: "asset-b", eventId: "event-b", name: "Second media", kind: "image", mode: "managed", state: "ready", available: true },
  ],
  jobs: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("restores the active project's event and keeps an explicitly selected event", async () => {
  vi.stubGlobal("mpvfx", { library: vi.fn(async () => ({ libraries: [library] })) });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (projectId: string) => (
    <LibraryNavigator projectId={projectId} beforeSwitch={async () => undefined} />
  );
  try {
    await act(async () => root.render(render("project-b")));
    const event = host.querySelector<HTMLSelectElement>('[aria-label="Event"]')!;
    const project = host.querySelector<HTMLSelectElement>('[aria-label="Project"]')!;
    expect(event.value).toBe("event-b");
    expect(project.value).toBe("project-b");
    expect(host.textContent).toContain("Second media");
    expect(host.textContent).not.toContain("First media");

    await act(async () => {
      event.value = "event-a";
      event.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(event.value).toBe("event-a");
    expect(project.value).toBe("");
    expect(host.textContent).toContain("First media");
    expect(host.textContent).not.toContain("Second media");

    await act(async () => root.render(render("project-b")));
    expect(event.value).toBe("event-a");
  } finally {
    await act(async () => root.unmount());
  }
});
