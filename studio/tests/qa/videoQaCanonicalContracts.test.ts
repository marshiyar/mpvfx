import { describe, expect, it } from "vitest";

import { VIDEO_QA_BEHAVIOR_CONTRACTS } from "./videoQaContractTypes";
import {
  assertVideoQaBehaviorContract,
  auditAudioVideoSyncContract,
  auditCompositingPixelContract,
} from "./videoQaContractHarness";

describe("canonical Q&A-derived video invariant contracts", () => {
  for (const [index, contract] of VIDEO_QA_BEHAVIOR_CONTRACTS.entries()) {
    it(`executes the ${contract} behavioral contract`, async () => {
      await assertVideoQaBehaviorContract(contract, 10_000 + index);
    });
  }

  it("proves audio/video synchronization through the real direct-export command", async () => {
    const audit = await auditAudioVideoSyncContract(20_001);

    expect(audit.exported).toBe(true);
    expect(audit.args).toContain("0:v:0");
    expect(audit.args).toContain("0:a:0?");
    expect(audit.args).toContain("48000");
    expect(audit.args).toContain("2");
    expect(audit.args.at(-1)).toBe("/project/out.mp4");
  });

  it("proves compositing stability through byte-identical native frame application", () => {
    const audit = auditCompositingPixelContract(20_002);

    expect(audit.firstStyle).toBe(audit.repeatedStyle);
    expect(audit.visibleClipIds).toEqual(["foreground"]);
    expect(audit.hiddenClipIds).toEqual(["background"]);
  });
});
