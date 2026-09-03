import { describe, expect, it } from "vitest";

import {
  VIDEO_QA_BEHAVIOR_CONTRACTS,
  VIDEO_QA_CONTRACT_FAMILY,
} from "./videoQaContractTypes";
import { loadVideoQaCorpus } from "./videoQaCorpus";
import { registerVideoQaContractTests } from "./videoQaContractHarness";
import { VIDEO_QA_INVARIANT_MAP_PART1 } from "./videoQaInvariantMap.part1";

registerVideoQaContractTests("video Q&A contracts lines 1-198", VIDEO_QA_INVARIANT_MAP_PART1);

describe("video Q&A partition 1 integrity", () => {
  it("keeps exactly 198 source-ordered, unique mappings", () => {
    const corpus = loadVideoQaCorpus();
    expect(VIDEO_QA_INVARIANT_MAP_PART1).toHaveLength(198);
    expect(VIDEO_QA_INVARIANT_MAP_PART1.map((entry) => entry.sourceLine)).toEqual(
      Array.from({ length: 198 }, (_, index) => index + 1),
    );
    expect(new Set(VIDEO_QA_INVARIANT_MAP_PART1.map((entry) => entry.questionId)).size).toBe(198);
    for (const entry of VIDEO_QA_INVARIANT_MAP_PART1) {
      expect(corpus[entry.sourceLine - 1]?.question_id).toBe(entry.questionId);
    }
  });

  it("pins each contract family to its source question", () => {
    const corpus = loadVideoQaCorpus();
    for (const entry of VIDEO_QA_INVARIANT_MAP_PART1) {
      expect(VIDEO_QA_BEHAVIOR_CONTRACTS).toContain(entry.contract);
      expect(entry.family).toBe(VIDEO_QA_CONTRACT_FAMILY[entry.contract]);
      const source = corpus[entry.sourceLine - 1]!;
      expect(source.question_id).toBe(entry.questionId);
    }
  });

  it("keeps semantic audit cases on their specific contracts", () => {
    const byId = new Map(
      VIDEO_QA_INVARIANT_MAP_PART1.map((entry) => [entry.questionId, entry]),
    );
    expect(byId.get(1334975)).toMatchObject({
      family: "timebase-seeking",
      contract: "frame-rate-timebase",
    });
    expect(byId.get(34416641)).toMatchObject({
      family: "streaming",
      contract: "stream-manifest-rejection",
    });
  });

  it("uses only supported contracts for GOP and interpolation source topics", () => {
    const unsupported = new Set(["codec-gop-random-access", "frame-synthesis-interpolation"]);
    expect(VIDEO_QA_INVARIANT_MAP_PART1.some((entry) => unsupported.has(entry.contract))).toBe(false);
    expect(VIDEO_QA_INVARIANT_MAP_PART1.find((entry) => entry.questionId === 12538914)).toMatchObject({
      family: "media-import-probe",
      contract: "thumbnail-frame-extraction",
    });
    expect(VIDEO_QA_INVARIANT_MAP_PART1.find((entry) => entry.questionId === 42331046)).toMatchObject({
      family: "timebase-seeking",
      contract: "frame-rate-timebase",
    });
  });
});
