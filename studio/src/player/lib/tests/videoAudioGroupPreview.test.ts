// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { audioGroupOf, isMemberGroupHidden, resolveAudioGroups } from "@hyperframes/core/audio-groups";

function preview(markup: string): Document {
  const document = window.document.implementation.createHTMLDocument("audio preview");
  document.body.innerHTML = markup;
  return document;
}

describe("video audio-group preview membership", () => {
  it("routes a sounding video and audio clip through the same bus settings", () => {
    const document = preview(`
      <hf-audio-group id="bus" data-volume="0.5" data-hidden></hf-audio-group>
      <video id="camera" data-start="0" data-has-audio="true" data-audio-group="bus"></video>
      <audio id="music" data-start="0" data-audio-group="bus"></audio>
      <video id="silent" data-start="0" data-has-audio="false" data-audio-group="bus"></video>
    `);
    const camera = document.getElementById("camera")!;
    const music = document.getElementById("music")!;
    expect(resolveAudioGroups(document)).toEqual([expect.objectContaining({
      id: "bus", memberIds: ["camera", "music"], volume: 0.5, hidden: true,
    })]);
    expect(audioGroupOf(camera)).toBe("bus");
    expect(audioGroupOf(music)).toBe("bus");
    expect(isMemberGroupHidden(document, camera)).toBe(true);
    expect(audioGroupOf(document.getElementById("silent")!)).toBeNull();
  });

  it("detached video audio has one sounding bus member", () => {
    const document = preview(`
      <hf-audio-group id="bus" data-volume="0.5"></hf-audio-group>
      <video id="camera" data-start="0" data-has-audio="false" muted></video>
      <audio id="detached" data-start="0" data-audio-group="bus"></audio>
    `);
    expect(resolveAudioGroups(document)[0]?.memberIds).toEqual(["detached"]);
    expect(audioGroupOf(document.getElementById("camera")!)).toBeNull();
  });
});
