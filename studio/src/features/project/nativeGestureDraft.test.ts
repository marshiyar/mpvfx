// @vitest-environment happy-dom

import { beforeEach, expect, it } from "vitest";
import { beginStudioManualEditGesture, endStudioManualEditGesture } from "../canvas/manualEdits";
import { applyNativeFrameToDocument, type NativeClipFrameBinding } from "./nativeFrameApplication";
import {
  captureActiveGestureGeometry,
  captureNativeGestureCommitCandidate,
  captureNativeGestureDraft,
  retainCommittedNativeGestureDraft,
  releaseCommittedNativeGestureDrafts,
} from "./nativeGestureDraft";

const oldFrame: NativeClipFrameBinding = {
  clipId: "clip:a", startFrame: 0, durationFrames: 30,
  staticParameters: { "transform.rotation": 0 }, parameterTracks: [],
};

beforeEach(() => document.body.replaceChildren());

function mountedNativeElement(): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-studio-clip-id", "clip:a");
  document.body.append(element);
  applyNativeFrameToDocument(document, [oldFrame], 0);
  return element;
}

it("keeps a committed picture after marker release until its revision is installed", () => {
  const element = mountedNativeElement();
  const token = beginStudioManualEditGesture(element);
  element.style.transform = "rotate(70deg)";
  captureNativeGestureDraft(element);
  const candidate = captureNativeGestureCommitCandidate(element);
  retainCommittedNativeGestureDraft(candidate, "project:a", 2);
  endStudioManualEditGesture(element, token);

  applyNativeFrameToDocument(document, [oldFrame], 0);
  expect(element.style.transform).toBe("rotate(70deg)");
  releaseCommittedNativeGestureDrafts(document, "project:a", 1);
  applyNativeFrameToDocument(document, [oldFrame], 0);
  expect(element.style.transform).toBe("rotate(70deg)");
  releaseCommittedNativeGestureDrafts(document, "project:b", 2);
  applyNativeFrameToDocument(document, [oldFrame], 0);
  expect(element.style.transform).toBe("rotate(70deg)");
  releaseCommittedNativeGestureDrafts(document, "project:a", 2);
  applyNativeFrameToDocument(document, [oldFrame], 0);
  expect(element.style.transform).toContain("rotate(0deg)");
});

it("restores a released resize through a stale GSAP tick until its revision installs", () => {
  const element = mountedNativeElement();
  const token = beginStudioManualEditGesture(element);
  element.style.width = "250px";
  element.style.height = "125px";
  element.style.clipPath = "inset(8px 20px 12px 40px)";
  retainCommittedNativeGestureDraft(captureNativeGestureCommitCandidate(element), "project:a", 2);
  endStudioManualEditGesture(element, token);

  const restore = captureActiveGestureGeometry(document);
  element.style.width = "400px";
  element.style.height = "200px";
  element.style.clipPath = "inset(16px 40px 24px 80px)";
  restore();
  expect([element.style.width, element.style.height, element.style.clipPath]).toEqual([
    "250px", "125px", "inset(8px 20px 12px 40px)",
  ]);

  releaseCommittedNativeGestureDrafts(document, "project:a", 2);
  const afterRelease = captureActiveGestureGeometry(document);
  element.style.width = "400px";
  afterRelease();
  expect(element.style.width).toBe("400px");
});

it("lets a newer active gesture override an older hold and never releases revision two at revision one", () => {
  const element = mountedNativeElement();
  const first = beginStudioManualEditGesture(element);
  element.style.transform = "rotate(30deg)";
  retainCommittedNativeGestureDraft(captureNativeGestureCommitCandidate(element), "project:a", 1);
  endStudioManualEditGesture(element, first);

  const second = beginStudioManualEditGesture(element);
  element.style.transform = "rotate(80deg)";
  captureNativeGestureDraft(element);
  const secondCandidate = captureNativeGestureCommitCandidate(element);
  applyNativeFrameToDocument(document, [oldFrame], 0);
  expect(element.style.transform).toBe("rotate(80deg)");
  retainCommittedNativeGestureDraft(secondCandidate, "project:a", 2);
  endStudioManualEditGesture(element, second);
  releaseCommittedNativeGestureDrafts(document, "project:a", 1);
  applyNativeFrameToDocument(document, [oldFrame], 0);
  expect(element.style.transform).toBe("rotate(80deg)");
  releaseCommittedNativeGestureDrafts(document, "project:a", 2);
  applyNativeFrameToDocument(document, [oldFrame], 0);
  expect(element.style.transform).toContain("rotate(0deg)");
});

it("retains the first release snapshot when its save finishes during a second gesture", () => {
  const element = mountedNativeElement();
  const first = beginStudioManualEditGesture(element);
  element.style.transform = "rotate(30deg)";
  const firstCandidate = captureNativeGestureCommitCandidate(element);
  endStudioManualEditGesture(element, first);

  const second = beginStudioManualEditGesture(element);
  element.style.transform = "rotate(80deg)";
  captureNativeGestureDraft(element);
  retainCommittedNativeGestureDraft(firstCandidate, "project:a", 1);
  applyNativeFrameToDocument(document, [oldFrame], 0);
  expect(element.style.transform).toBe("rotate(80deg)");

  // If the second save fails, its marker ends and the first committed pose
  // remains until revision one installs.
  endStudioManualEditGesture(element, second);
  applyNativeFrameToDocument(document, [oldFrame], 0);
  expect(element.style.transform).toBe("rotate(30deg)");
  releaseCommittedNativeGestureDrafts(document, "project:a", 1);
  applyNativeFrameToDocument(document, [oldFrame], 0);
  expect(element.style.transform).toContain("rotate(0deg)");
});

it("does not retain a failed gesture that never produced a committed revision", () => {
  const element = mountedNativeElement();
  const token = beginStudioManualEditGesture(element);
  element.style.transform = "rotate(45deg)";
  captureNativeGestureDraft(element);
  // A rejected save never calls retainCommittedNativeGestureDraft.
  endStudioManualEditGesture(element, token);
  applyNativeFrameToDocument(document, [oldFrame], 0);
  expect(element.style.transform).toContain("rotate(0deg)");
});
