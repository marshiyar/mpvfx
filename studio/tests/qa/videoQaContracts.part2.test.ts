import { describe, expect, it } from "vitest";

import { registerVideoQaContractTests } from "./videoQaContractHarness";
import { loadVideoQaCorpus } from "./videoQaCorpus";
import { VIDEO_QA_INVARIANT_FAMILIES } from "./videoQaContractTypes";
import { VIDEO_QA_INVARIANT_MAP_PART2 } from "./videoQaInvariantMap.part2";

registerVideoQaContractTests(
  "video Q&A contracts lines 199-396",
  VIDEO_QA_INVARIANT_MAP_PART2,
);

describe("video Q&A partition 2 traceability", () => {
  it("pins specialized rendering concepts to their transferable contracts", () => {
    const byId = new Map(VIDEO_QA_INVARIANT_MAP_PART2.map((entry) => [entry.questionId, entry]));
    expect(byId.get(15927656)).toMatchObject({ family: "gpu-interpolation", contract: "compositing-pixel-stability" });
    expect(byId.get(60859233)).toMatchObject({ family: "gpu-interpolation", contract: "compositing-pixel-stability" });
    expect(byId.get(56403140)).toMatchObject({ family: "gpu-interpolation", contract: "compositing-pixel-stability" });
    expect(byId.get(35694900)).toMatchObject({ family: "gpu-interpolation", contract: "compositing-pixel-stability" });
    expect(byId.get(67239289)).toMatchObject({ family: "audio-sync", contract: "audio-video-sync" });
  });

  it("contains exactly the source rows 199 through 396 in order", () => {
    const corpus = loadVideoQaCorpus();
    expect(VIDEO_QA_INVARIANT_MAP_PART2).toHaveLength(198);
    expect(VIDEO_QA_INVARIANT_MAP_PART2.map((entry) => entry.sourceLine)).toEqual(
      Array.from({ length: 198 }, (_, index) => index + 199),
    );
    expect(VIDEO_QA_INVARIANT_MAP_PART2.map((entry) => entry.questionId)).toEqual(
      corpus.slice(198, 396).map((record) => record.question_id),
    );
    expect(new Set(VIDEO_QA_INVARIANT_MAP_PART2.map((entry) => entry.questionId)).size).toBe(198);
    expect(VIDEO_QA_INVARIANT_MAP_PART2.every((entry) => VIDEO_QA_INVARIANT_FAMILIES.includes(entry.family))).toBe(true);
  });
});
