import { describe, expect, it } from "vitest";
import {
  VIDEO_QA_BEHAVIOR_CONTRACTS,
  VIDEO_QA_CONTRACT_FAMILY,
  VIDEO_QA_INVARIANT_FAMILIES,
} from "./videoQaContractTypes";
import { VIDEO_QA_INVARIANT_MAP } from "./videoQaInvariantMap";

// The external question corpus was retired. Keep the numeric case seeds and
// executable editor contracts; copied question/answer text is not a test input.
describe("video behavior case coverage", () => {
  it("retains all deterministic cases without duplicate seeds", () => {
    expect(VIDEO_QA_INVARIANT_MAP).toHaveLength(593);
    expect(
      new Set(VIDEO_QA_INVARIANT_MAP.map((entry) => entry.questionId)).size,
    ).toBe(593);
  });

  it("exercises every declared behavior and family", () => {
    expect(
      [
        ...new Set(VIDEO_QA_INVARIANT_MAP.map((entry) => entry.contract)),
      ].sort(),
    ).toEqual([...VIDEO_QA_BEHAVIOR_CONTRACTS].sort());
    expect(
      [...new Set(VIDEO_QA_INVARIANT_MAP.map((entry) => entry.family))].sort(),
    ).toEqual([...VIDEO_QA_INVARIANT_FAMILIES].sort());
    for (const entry of VIDEO_QA_INVARIANT_MAP) {
      expect(entry.family).toBe(VIDEO_QA_CONTRACT_FAMILY[entry.contract]);
    }
  });
});
