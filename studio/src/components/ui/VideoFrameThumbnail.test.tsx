// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VideoFrameThumbnail } from "./VideoFrameThumbnail";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
let host: HTMLDivElement;
let root: Root;
let videos: HTMLVideoElement[];
const drawImage = vi.fn();

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  videos = [];
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
    const element = createElement(tag, options);
    if (tag === "video") {
      const video = element as HTMLVideoElement;
      Object.defineProperties(video, {
        duration: { value: 10 }, videoWidth: { value: 640 }, videoHeight: { value: 360 },
      });
      vi.spyOn(video, "load").mockImplementation(() => {});
      videos.push(video);
    }
    return element;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,frame");
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  drawImage.mockReset();
});

function render(src = "/clip.mp4") {
  act(() => root.render(<VideoFrameThumbnail src={src} />));
  return videos.at(-1)!;
}
function emit(video: HTMLVideoElement, event: string) {
  act(() => { video.dispatchEvent(new Event(event)); });
}

it.each(["error", "seeked"])("releases the decoder once after %s, ignoring cleanup-generated events", (event) => {
  const video = render();
  emit(video, "loadedmetadata");
  emit(video, event);
  if (event === "seeked") expect(host.querySelector("img")?.getAttribute("src")).toContain("base64,frame");
  else expect(host.textContent).toBe("VIDEO");
  const loadCount = vi.mocked(video.load).mock.calls.length;
  // Chromium can enqueue an error after releasing a media source. It must not
  // re-enter setState/load indefinitely while the editor otherwise sits idle.
  for (let i = 0; i < 5; i++) emit(video, "error");
  emit(video, "seeked");
  expect(video.load).toHaveBeenCalledTimes(loadCount);
  expect(drawImage).toHaveBeenCalledTimes(event === "seeked" ? 1 : 0);
  expect(video.hasAttribute("src")).toBe(false);
});

it("ignores stale media events after changing source and clears the previous thumbnail", () => {
  const previous = render();
  emit(previous, "seeked");
  const next = render("/next.mp4");
  expect(host.querySelector("img")).toBeNull();
  emit(previous, "seeked");
  emit(previous, "error");
  expect(host.querySelector(".animate-pulse")).not.toBeNull();
  expect(drawImage).toHaveBeenCalledTimes(1);
  emit(next, "seeked");
  expect(host.querySelector("img")).not.toBeNull();
});

it("settles to the fallback and releases media when extracting a frame throws", () => {
  const video = render();
  drawImage.mockImplementationOnce(() => { throw new Error("decoder failed"); });
  emit(video, "seeked");
  expect(host.textContent).toBe("VIDEO");
  expect(video.hasAttribute("src")).toBe(false);
});
