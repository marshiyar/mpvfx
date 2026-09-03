import type { VideoQaInvariantEntry } from "./videoQaContractTypes";
import { VIDEO_QA_INVARIANT_MAP_PART1 } from "./videoQaInvariantMap.part1";
import { VIDEO_QA_INVARIANT_MAP_PART2 } from "./videoQaInvariantMap.part2";
import { VIDEO_QA_INVARIANT_MAP_PART3 } from "./videoQaInvariantMap.part3";

/**
 * Complete trace map assembled from independently reviewed, non-overlapping
 * corpus partitions. The trace test proves this is an exact set equality with
 * the source JSONL rather than trusting the partition declarations.
 */
export const VIDEO_QA_INVARIANT_MAP: readonly VideoQaInvariantEntry[] = [
  ...VIDEO_QA_INVARIANT_MAP_PART1,
  ...VIDEO_QA_INVARIANT_MAP_PART2,
  ...VIDEO_QA_INVARIANT_MAP_PART3,
];
