// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument, serializeNativeProjectDocument,
} from "../../../../shared/project/nativeProjectDocument";
import { useSetElementAttribute } from "../timelineElementFxAttribute";

it("routes a native clip FX write through sidecar and HTML history", async () => {
  const project = parseNativeProjectDocument({
    schemaVersion: 1, mediaEngine: "ffmpeg", id: "project", revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 64, height: 32, background: "#000000" },
    assets: [{ id: "asset", kind: "audio", name: "voice.wav", source: "assets/voice.wav", durationFrames: 120 }],
    sequence: { id: "sequence", name: "Sequence", tracks: [{
      id: "audio-track", kind: "audio", clips: [{
        id: "native-audio", assetId: "asset", binding: { sourceFile: "index.html", domId: "voice" },
        startFrame: 0, durationFrames: 60, sourceInFrame: 0, muted: false,
        staticParameters: {}, effects: [], parameterTracks: [],
      }],
    }] },
  });
  const files = new Map([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(project)],
    ["index.html", '<html><body><audio id="voice" src="assets/voice.wav" data-start="0" data-duration="2"></audio></body></html>'],
  ]);
  const nativeDocumentRef = { current: project };
  const recordEdit = vi.fn(async () => {});
  const showToast = vi.fn();
  const reloadPreview = vi.fn();
  const input = {
    projectIdRef: { current: "project" }, activeCompPath: "index.html", showToast,
    writeProjectFile: async (path: string, content: string, expected?: string) => {
      expect(files.get(path)).toBe(expected);
      files.set(path, content);
    },
    recordEdit, domEditSaveTimestampRef: { current: 0 },
    pendingTimelineEditPathRef: { current: new Set<string>() },
    previewIframeRef: { current: null }, nativeDocumentRef,
    nativeProjectEditing: {
      readOptionalProjectFile: async (path: string) => files.get(path),
      onNativeDocumentCommitted: (document: typeof project) => { nativeDocumentRef.current = document; },
    },
    editQueueRef: { current: Promise.resolve() }, reloadPreview,
  };
  let setter: ReturnType<typeof useSetElementAttribute> | null = null;
  const Probe = () => { setter = useSetElementAttribute(input as never); return null; };
  renderToStaticMarkup(React.createElement(Probe));
  const chain = '{"version":1,"nodes":[]}';
  await setter!.setQuiet({ id: "voice", domId: "voice", sourceFile: "index.html", tag: "audio",
    start: 0, duration: 2, track: 0 }, "data-fx-chain", chain, "Set clip FX");
  expect(showToast).not.toHaveBeenCalled();
  expect(nativeDocumentRef.current.sequence.tracks[0]!.clips[0]!.audioFxChain).toBe(chain);
  expect(files.get("index.html")).toContain("data-fx-chain=");
  expect(recordEdit).toHaveBeenCalledOnce();
  expect(reloadPreview).toHaveBeenCalledOnce();
});
