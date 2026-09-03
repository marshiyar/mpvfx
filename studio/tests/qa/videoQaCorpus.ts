import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { VideoQaSourceRecord } from "./videoQaContractTypes";

export const VIDEO_QA_CORPUS_PATH = fileURLToPath(
  new URL("../../../third_party/stackexchange-video-qa/data/video-qa.jsonl", import.meta.url),
);

export function loadVideoQaCorpus(): readonly VideoQaSourceRecord[] {
  return readFileSync(VIDEO_QA_CORPUS_PATH, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as VideoQaSourceRecord;
      } catch (error) {
        throw new Error(`Invalid video Q&A JSON on line ${index + 1}`, { cause: error });
      }
    });
}
