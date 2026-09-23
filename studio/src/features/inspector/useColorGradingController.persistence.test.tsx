// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeHfColorGrading,
  serializeHfColorGrading,
} from "@hyperframes/core/color-grading";
import { useColorGradingController } from "./useColorGradingController";
import {
  useDomEditCommits,
  type UseDomEditCommitsParams,
} from "../canvas/useDomEditCommits";
import type { DomEditSelection } from "../canvas/domEditing";
import { FlatColorGradingSection } from "./propertyPanelFlatColorGradingSection";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const grade = (preset: string, intensity = 1) => {
  const value = normalizeHfColorGrading({ preset, intensity });
  if (!value) throw new Error("Invalid test grading");
  return value;
};
const first = grade("bright-pop");
const second = grade("clean-studio");
const third = grade("bright-pop", 0.3);

function mountPersistence(withControls = false) {
  let disk = '<video id="clip"></video>';
  const writes: Array<{ value: string; succeed(): void; fail(): void }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/files/")) return Response.json({ content: disk });
      if (url.includes("/file-mutations/patch-element/")) {
        const { operations } = JSON.parse(String(init?.body)) as {
          operations: Array<{ value: string }>;
        };
        return new Promise<Response>((resolve, reject) =>
          writes.push({
            value: operations[0].value,
            succeed: () => {
              disk = `<video id="clip" data-color-grading='${operations[0].value}'></video>`;
              resolve(
                Response.json({
                  ok: true,
                  matched: true,
                  changed: true,
                  content: disk,
                }),
              );
            },
            fail: () => reject(new Error("Diagnostic save failure")),
          }),
        );
      }
      return Response.json({});
    }),
  );
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const doc = iframe.contentDocument!;
  doc.body.innerHTML =
    '<div data-composition-id="main"><video id="clip" data-hf-id="hf-clip"></video></div>';
  const element = doc.querySelector<HTMLVideoElement>("#clip")!;
  const selection: DomEditSelection = {
    element,
    id: "clip",
    hfId: "hf-clip",
    selector: "#clip",
    selectorIndex: 0,
    label: "Clip",
    tagName: "video",
    sourceFile: "index.html",
    compositionPath: "index.html",
    isCompositionHost: false,
    isInsideLockedComposition: false,
    boundingBox: { x: 0, y: 0, width: 640, height: 360 },
    textContent: "",
    dataAttributes: {},
    inlineStyles: {},
    computedStyles: {},
    textFields: [],
    capabilities: {
      canSelect: true,
      canEditStyles: true,
      canCrop: true,
      canMove: true,
      canResize: true,
      canApplyManualOffset: true,
      canApplyManualSize: true,
      canApplyManualRotation: true,
    },
  };
  let previewGrading = grade("neutral");
  vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(
    (message) => {
      if (message?.action === "set-color-grading") {
        previewGrading = normalizeHfColorGrading(message.grading ?? "neutral")!;
      }
    },
  );
  const options: UseDomEditCommitsParams = {
    projectId: "p1",
    projectIdRef: { current: "p1" },
    activeCompPath: "index.html",
    previewIframeRef: { current: iframe },
    domEditSelection: selection,
    queueDomEditSave: async (save) => save(),
    writeProjectFile: async () => {},
    domEditSaveTimestampRef: { current: 0 },
    editHistory: { recordEdit: vi.fn(async () => {}) },
    fileTree: [],
    importedFontAssetsRef: { current: [] },
    showToast: vi.fn(),
    reloadPreview: vi.fn(),
    applyDomSelection: vi.fn(),
    clearDomSelection: vi.fn(),
    refreshDomEditSelectionFromPreview: vi.fn(),
    buildDomSelectionFromTarget: async () => null,
  };
  let controller!: ReturnType<typeof useColorGradingController>;
  function Harness() {
    const persistence = useDomEditCommits(options);
    controller = useColorGradingController({
      projectId: "p1",
      element: selection,
      previewIframeRef: options.previewIframeRef,
      onSetAttributeLive: persistence.handleDomAttributeLiveCommit,
    });
    return withControls ? (
      <FlatColorGradingSection
        grading={controller.grading}
        assets={[]}
        onCommitColorGrading={controller.commitColorGrading}
        onPreviewColorGrading={controller.previewColorGrading}
        applyScope="source-file"
        applyBusy={false}
        onSetApplyScope={() => {}}
        onApplyToScope={() => {}}
        onApplyScopeAvailable={false}
        mediaMetadata={null}
        presetPreviews={{
          status: "unavailable",
          images: {},
          width: 16,
          height: 9,
        }}
        onRequestPresetPreviews={() => {}}
        captureGradedFrame={async () => null}
      />
    ) : null;
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  return {
    host,
    writes,
    get state() {
      return controller;
    },
    get preview() {
      return previewGrading;
    },
    get disk() {
      return disk;
    },
    commit: async (value: typeof first) => {
      act(() => controller.commitColorGrading(value));
      await act(async () => vi.advanceTimersByTimeAsync(400));
    },
    cleanup: () => {
      act(() => root.unmount());
      iframe.remove();
      host.remove();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("grading through actual DOM attribute persistence", () => {
  it.each(["success-first", "failure-first"] as const)(
    "converges the controls and preview to saved A when B fails (%s)",
    async (order) => {
      vi.useFakeTimers();
      const h = mountPersistence();
      try {
        await h.commit(first);
        await h.commit(second);
        expect(h.writes).toHaveLength(2);
        if (order === "success-first") {
          await act(async () => h.writes[0].succeed());
          await act(async () => h.writes[1].fail());
        } else {
          await act(async () => h.writes[1].fail());
          await act(async () => h.writes[0].succeed());
        }
        expect(h.disk).toContain(serializeHfColorGrading(first));
        expect(h.state.grading).toEqual(first);
        expect(h.preview).toEqual(first);
      } finally {
        h.cleanup();
      }
    },
  );

  it.each(["preview", "preview-before-failure", "commit"] as const)(
    "keeps newer C %s visible when A succeeds after B fails",
    async (kind) => {
      vi.useFakeTimers();
      const h = mountPersistence();
      try {
        await h.commit(first);
        await h.commit(second);
        if (kind === "preview-before-failure")
          act(() => h.state.previewColorGrading(third));
        await act(async () => h.writes[1].fail());
        if (kind === "preview") act(() => h.state.previewColorGrading(third));
        else if (kind === "commit") await h.commit(third);
        await act(async () => h.writes[0].succeed());
        expect(h.preview).toEqual(third);
        if (kind !== "commit") {
          act(() => h.state.previewColorGrading(null));
        } else {
          await act(async () => h.writes[2].fail());
        }
        expect(h.state.grading).toEqual(first);
        expect(h.preview).toEqual(first);
      } finally {
        h.cleanup();
      }
    },
  );

  it.each([
    ["wheel", "Escape"],
    ["wheel", "pointercancel"],
    ["wheel", "lostpointercapture"],
    ["wheel", "no-op release"],
    ["curve", "Escape"],
    ["curve", "pointercancel"],
    ["curve", "lostpointercapture"],
    ["curve", "no-op release"],
  ] as const)(
    "ends a real %s preview on %s and converges to late saved A",
    async (control, ending) => {
      vi.useFakeTimers();
      const h = mountPersistence(true);
      try {
        await h.commit(first);
        await h.commit(second);
        await act(async () => h.writes[1].fail());
        const surface = h.host.querySelector(
          control === "wheel"
            ? '[data-color-wheel="shadows"] [data-color-wheel-surface="true"]'
            : '[data-color-curve-graph="master"]',
        );
        if (!surface) throw new Error(`Missing ${control}`);
        const size = control === "wheel" ? 100 : 160;
        Object.defineProperty(surface, "getBoundingClientRect", {
          value: () => ({
            left: 0,
            top: 0,
            width: size,
            height: size,
            right: size,
            bottom: size,
          }),
        });
        const noOp = ending === "no-op release";
        const [clientX, clientY] =
          control === "wheel"
            ? [noOp ? 50 : 100, 50]
            : [noOp ? 8 : 80, noOp ? 152 : 50];
        const pointer = (type: string) =>
          surface.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              pointerId: 7,
              clientX,
              clientY,
            }),
          );
        act(() => {
          pointer("pointerdown");
        });
        const liveDraft = h.preview;
        await act(async () => h.writes[0].succeed());
        expect(h.preview).toEqual(liveDraft);
        act(() => {
          if (ending === "Escape") {
            surface.dispatchEvent(
              new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
            );
          } else {
            pointer(noOp ? "pointerup" : ending);
          }
        });
        expect(h.state.grading).toEqual(first);
        expect(h.preview).toEqual(first);
        // Escape/pointercancel terminate ownership even when a physical release follows.
        if (!noOp)
          act(() => {
            pointer("pointerup");
          });
        await act(async () => vi.advanceTimersByTimeAsync(400));
        expect(h.writes).toHaveLength(2);
        expect(h.preview).toEqual(first);
      } finally {
        h.cleanup();
      }
    },
  );
});
