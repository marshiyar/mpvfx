// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openComposition = vi.fn();

vi.mock("@hyperframes/sdk", () => ({
  openComposition: (...args: unknown[]) => openComposition(...args),
}));

import type { Composition } from "@hyperframes/sdk";
import { useSdkSession, type SdkSessionHandle } from "../useSdkSession";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeSession(): Composition {
  return { dispose: vi.fn() } as unknown as Composition;
}

function response(content: string): Response {
  return { ok: true, json: async () => ({ content }) } as Response;
}

async function flushAsyncEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useSdkSession ownership", () => {
  beforeEach(() => {
    openComposition.mockReset();
    class FakeEventSource {
      addEventListener(): void {}
      close(): void {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides project A immediately while project B with the same path is still opening", async () => {
    const sessionA = fakeSession();
    const publishedA = fakeSession();
    const sessionB = fakeSession();
    let resolveProjectB: ((value: Response) => void) | undefined;
    const projectBResponse = new Promise<Response>((resolve) => {
      resolveProjectB = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.includes("project-b") ? projectBResponse : Promise.resolve(response("PROJECT_A")),
      ),
    );
    openComposition.mockImplementation(async (content: string) =>
      content === "PROJECT_A" ? sessionA : sessionB,
    );

    const captured: { handle: SdkSessionHandle | null } = { handle: null };
    function Probe({ projectId }: { projectId: string }) {
      captured.handle = useSdkSession(projectId, "index.html");
      return null;
    }

    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe projectId="project-a" />));
    await flushAsyncEffects();
    expect(captured.handle?.session).toBe(sessionA);

    let publication: ReturnType<SdkSessionHandle["publish"]> | undefined;
    await act(async () => {
      publication = captured.handle?.publish({
        candidate: publishedA,
        expectedSession: sessionA,
        targetPath: "index.html",
      });
    });
    expect(publication).toBe("published");
    expect(captured.handle?.session).toBe(publishedA);

    await act(async () => root.render(<Probe projectId="project-b" />));
    expect(captured.handle?.session).toBeNull();
    expect(publishedA.dispose).toHaveBeenCalledOnce();
    expect(
      captured.handle?.publish({
        candidate: fakeSession(),
        expectedSession: publishedA,
        targetPath: "index.html",
      }),
    ).toBe("rejected-inactive-target");

    resolveProjectB?.(response("PROJECT_B"));
    await flushAsyncEffects();
    expect(captured.handle?.session).toBe(sessionB);

    await act(async () => root.unmount());
    expect(sessionB.dispose).toHaveBeenCalledOnce();
  });

  it("disposes the currently published candidate when its owner unmounts", async () => {
    const opened = fakeSession();
    const published = fakeSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response("PROJECT_A")),
    );
    openComposition.mockResolvedValue(opened);

    const captured: { handle: SdkSessionHandle | null } = { handle: null };
    function Probe() {
      captured.handle = useSdkSession("project-a", "index.html");
      return null;
    }

    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await flushAsyncEffects();
    expect(captured.handle?.session).toBe(opened);
    let publication: ReturnType<SdkSessionHandle["publish"]> | undefined;
    await act(async () => {
      publication = captured.handle?.publish({
        candidate: published,
        expectedSession: opened,
        targetPath: "index.html",
      });
    });
    expect(publication).toBe("published");
    expect(opened.dispose).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    expect(published.dispose).toHaveBeenCalledOnce();
  });

  it("retains only owner metadata across repeated publication, not predecessor sessions", async () => {
    const opened = fakeSession();
    const candidates = [fakeSession(), fakeSession(), fakeSession()];
    vi.stubGlobal("fetch", vi.fn(async () => response("PROJECT_A")));
    openComposition.mockResolvedValue(opened);
    const registrations = vi.spyOn(WeakMap.prototype, "set");
    const captured: { handle: SdkSessionHandle | null } = { handle: null };
    function Probe() {
      captured.handle = useSdkSession("project-a", "index.html");
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Probe />));
      await flushAsyncEffects();
      const initialOwner = registrations.mock.calls.find(([key]) => key === opened)?.[1];
      expect(initialOwner).toEqual({
        projectId: "project-a",
        path: "index.html",
        reloadToken: 0,
        generation: expect.any(Number),
      });
      let previous = opened;
      for (const candidate of candidates) {
        let result: ReturnType<SdkSessionHandle["publish"]> | undefined;
        await act(async () => {
          result = captured.handle?.publish({
            candidate,
            expectedSession: previous,
            targetPath: "index.html",
          });
        });
        expect(result).toBe("published");
        expect(previous.dispose).toHaveBeenCalledOnce();
        expect(captured.handle?.session).toBe(candidate);
        previous = candidate;
      }
      for (const candidate of candidates) {
        // A WeakMap value can strongly retain another key. Owner records must
        // never link a candidate to the disposed Composition it replaced.
        const owner = registrations.mock.calls.find(([key]) => key === candidate)?.[1];
        expect(owner).toEqual(initialOwner);
        expect(owner).not.toHaveProperty("session");
      }
    } finally {
      await act(async () => root.unmount());
      registrations.mockRestore();
    }
  });
});
