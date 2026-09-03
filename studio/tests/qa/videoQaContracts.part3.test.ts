import { describe, expect, it } from "vitest";

import { registerVideoQaContractTests } from "./videoQaContractHarness";
import { loadVideoQaCorpus } from "./videoQaCorpus";
import {
  VIDEO_QA_BEHAVIOR_CONTRACTS,
  VIDEO_QA_CONTRACT_FAMILY,
  VIDEO_QA_INVARIANT_FAMILIES,
  type VideoQaBehaviorContract,
} from "./videoQaContractTypes";
import { VIDEO_QA_INVARIANT_MAP_PART3 } from "./videoQaInvariantMap.part3";

registerVideoQaContractTests(
  "video Q&A contracts lines 397-593",
  VIDEO_QA_INVARIANT_MAP_PART3,
);

describe("video Q&A partition 3 traceability", () => {
  it("contains exactly the source rows 397 through 593 in order", () => {
    const corpus = loadVideoQaCorpus();
    expect(VIDEO_QA_INVARIANT_MAP_PART3).toHaveLength(197);
    expect(VIDEO_QA_INVARIANT_MAP_PART3.map((entry) => entry.sourceLine)).toEqual(
      Array.from({ length: 197 }, (_, index) => index + 397),
    );
    expect(VIDEO_QA_INVARIANT_MAP_PART3.map((entry) => entry.questionId)).toEqual(
      corpus.slice(396, 593).map((record) => record.question_id),
    );
    expect(new Set(VIDEO_QA_INVARIANT_MAP_PART3.map((entry) => entry.questionId)).size).toBe(197);
    expect(VIDEO_QA_INVARIANT_MAP_PART3.every((entry) => (
      VIDEO_QA_INVARIANT_FAMILIES.includes(entry.family)
    ))).toBe(true);
  });

  it("pins every behavior contract to its source question", () => {
    const corpus = loadVideoQaCorpus();
    for (const entry of VIDEO_QA_INVARIANT_MAP_PART3) {
      expect(VIDEO_QA_BEHAVIOR_CONTRACTS).toContain(entry.contract);
      expect(entry.family).toBe(VIDEO_QA_CONTRACT_FAMILY[entry.contract]);
      const source = corpus[entry.sourceLine - 1]!;
      expect(source.question_id).toBe(entry.questionId);
    }
  });

  it("keeps the second-pass semantic audit on specific editor behaviors", () => {
    const expectedContracts = new Map<number, VideoQaBehaviorContract>([
      [58577941, "codec-container-compatibility"],
      [66307974, "codec-container-compatibility"],
      [40922313, "stream-timestamp-continuity"],
      [11815060, "animation-keyframe-interpolation"],
      [76519126, "stream-timestamp-continuity"],
      [17508855, "compositing-pixel-stability"],
      [69605164, "trim-split-boundary"],
      [16881998, "animation-keyframe-interpolation"],
      [33780690, "animation-keyframe-interpolation"],
      [61912466, "codec-container-compatibility"],
      [78288854, "stream-timestamp-continuity"],
      [3653485, "stream-timestamp-continuity"],
      [66588431, "codec-container-compatibility"],
      [74814911, "trim-split-boundary"],
      [64055337, "audio-video-sync"],
      [77160993, "resource-worker-budget"],
      [24351112, "thumbnail-frame-extraction"],
      [27734995, "playback-pause-reseek"],
      [62270208, "thumbnail-frame-extraction"],
      [59985152, "decoder-probe-failure"],
      [69422502, "resource-worker-budget"],
      [76892367, "stream-timestamp-continuity"],
      [64318026, "codec-container-compatibility"],
      [77370814, "media-import-classification"],
      [76101007, "stream-timestamp-continuity"],
      [63322408, "codec-container-compatibility"],
      [67944286, "stream-timestamp-continuity"],
      [58738057, "stream-timestamp-continuity"],
      [52953416, "decoder-probe-failure"],
      [60517273, "thumbnail-frame-extraction"],
      [63664282, "stream-timestamp-continuity"],
      [33867895, "timeline-edit-integrity"],
      [13849627, "playback-pause-reseek"],
      [57636650, "compositing-pixel-stability"],
      [77031949, "playback-pause-reseek"],
      [19274716, "stream-timestamp-continuity"],
      [74312683, "stream-timestamp-continuity"],
      [52262747, "decoder-probe-failure"],
      [67357968, "resource-worker-budget"],
      [65779026, "resource-worker-budget"],
      [65820232, "audio-video-sync"],
      [78404208, "audio-video-sync"],
      [32020585, "resource-worker-budget"],
      [58678774, "stream-timestamp-continuity"],
      [33028747, "animation-keyframe-interpolation"],
      [66713425, "stream-timestamp-continuity"],
      [77440390, "resource-worker-budget"],
      [59473984, "frame-rate-timebase"],
      [43317489, "thumbnail-frame-extraction"],
      [77540081, "platform-capability-boundary"],
      [79281236, "stream-timestamp-continuity"],
      [78967374, "resource-worker-budget"],
      [60175949, "timeline-edit-integrity"],
      [72137056, "platform-capability-boundary"],
      [68618665, "decoder-probe-failure"],
      [73435040, "trim-split-boundary"],
      [17561395, "platform-capability-boundary"],
      [49877473, "codec-container-compatibility"],
      [52844222, "stream-manifest-rejection"],
      [48051720, "trim-split-boundary"],
      [74098091, "stream-manifest-rejection"],
      [75866230, "codec-container-compatibility"],
      [63763050, "platform-capability-boundary"],
      [60989598, "playback-pause-reseek"],
      [17902134, "compositing-pixel-stability"],
      [62041808, "compositing-pixel-stability"],
      [38780802, "animation-keyframe-interpolation"],
      [33595056, "timeline-edit-integrity"],
      [17699273, "platform-capability-boundary"],
    ]);
    const actual = new Map(
      VIDEO_QA_INVARIANT_MAP_PART3.map((entry) => [entry.questionId, entry.contract]),
    );
    const mismatches = [...expectedContracts].filter(
      ([questionId, contract]) => actual.get(questionId) !== contract,
    );

    expect(mismatches).toEqual([]);
  });

  it("maps GOP and synthesized-frame questions onto supported Studio behaviors", () => {
    const expectedContracts = new Map<number, VideoQaBehaviorContract>([
      [10358769, "thumbnail-frame-extraction"],
      [30920343, "codec-container-compatibility"],
      [66307974, "codec-container-compatibility"],
      [69605164, "trim-split-boundary"],
      [41392442, "playback-pause-reseek"],
      [68627606, "codec-container-compatibility"],
      [64717318, "codec-container-compatibility"],
      [45666155, "playback-pause-reseek"],
      [53907652, "codec-container-compatibility"],
      [37132117, "codec-container-compatibility"],
      [73059831, "codec-container-compatibility"],
      [75084977, "trim-split-boundary"],
      [63322408, "codec-container-compatibility"],
      [45916504, "animation-keyframe-interpolation"],
      [48051720, "trim-split-boundary"],
      [60726260, "trim-split-boundary"],
      [67638564, "playback-pause-reseek"],
      [13849627, "playback-pause-reseek"],
      [57878130, "compositing-pixel-stability"],
      [63388744, "trim-split-boundary"],
      [75838562, "codec-container-compatibility"],
      [79619949, "codec-container-compatibility"],
      [77281890, "thumbnail-frame-extraction"],
      [43173707, "thumbnail-frame-extraction"],
      [62041808, "compositing-pixel-stability"],
      [79809773, "trim-split-boundary"],
      [77977685, "thumbnail-frame-extraction"],
      [28508581, "compositing-pixel-stability"],
      [79424582, "codec-container-compatibility"],
      [59210380, "thumbnail-frame-extraction"],
      [56727200, "trim-split-boundary"],
    ]);
    const actual = new Map(
      VIDEO_QA_INVARIANT_MAP_PART3.map((entry) => [entry.questionId, entry.contract]),
    );
    const mismatches = [...expectedContracts].filter(
      ([questionId, contract]) => actual.get(questionId) !== contract,
    );

    expect(mismatches).toEqual([]);
  });
});
