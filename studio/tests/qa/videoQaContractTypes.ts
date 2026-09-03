export const VIDEO_QA_INVARIANT_FAMILIES = [
  "keyframes",
  "timebase-seeking",
  "media-import-probe",
  "codec-container",
  "export-encode",
  "audio-sync",
  "streaming",
  "timeline-edits",
  "transforms",
  "gpu-interpolation",
  "captions",
  "platform-adapters",
  "resource-cancellation",
] as const;

export type VideoQaInvariantFamily = (typeof VIDEO_QA_INVARIANT_FAMILIES)[number];

export const VIDEO_QA_BEHAVIOR_CONTRACTS = [
  "animation-keyframe-interpolation",
  "audio-automation-split",
  "audio-video-sync",
  "caption-timing",
  "codec-container-compatibility",
  "compositing-pixel-stability",
  "decoder-probe-failure",
  "export-alpha-color",
  "export-bitrate-size",
  "export-codec-policy",
  "export-resolution-limit",
  "frame-rate-timebase",
  "hardware-acceleration-policy",
  "media-import-classification",
  "platform-capability-boundary",
  "playback-pause-reseek",
  "render-cancellation-cleanup",
  "resource-worker-budget",
  "stream-manifest-rejection",
  "stream-timestamp-continuity",
  "thumbnail-frame-extraction",
  "timeline-edit-integrity",
  "transform-canvas-geometry",
  "trim-split-boundary",
] as const;

export type VideoQaBehaviorContract = (typeof VIDEO_QA_BEHAVIOR_CONTRACTS)[number];

export const VIDEO_QA_CONTRACT_FAMILY: Readonly<
  Record<VideoQaBehaviorContract, VideoQaInvariantFamily>
> = {
  "animation-keyframe-interpolation": "keyframes",
  "audio-automation-split": "audio-sync",
  "audio-video-sync": "audio-sync",
  "caption-timing": "captions",
  "codec-container-compatibility": "codec-container",
  "compositing-pixel-stability": "gpu-interpolation",
  "decoder-probe-failure": "media-import-probe",
  "export-alpha-color": "export-encode",
  "export-bitrate-size": "export-encode",
  "export-codec-policy": "export-encode",
  "export-resolution-limit": "export-encode",
  "frame-rate-timebase": "timebase-seeking",
  "hardware-acceleration-policy": "platform-adapters",
  "media-import-classification": "media-import-probe",
  "platform-capability-boundary": "platform-adapters",
  "playback-pause-reseek": "timebase-seeking",
  "render-cancellation-cleanup": "resource-cancellation",
  "resource-worker-budget": "resource-cancellation",
  "stream-manifest-rejection": "streaming",
  "stream-timestamp-continuity": "streaming",
  "thumbnail-frame-extraction": "media-import-probe",
  "timeline-edit-integrity": "timeline-edits",
  "transform-canvas-geometry": "transforms",
  "trim-split-boundary": "timeline-edits",
};

/** One auditable transfer from a source Q&A row into an editor behavior family. */
export interface VideoQaInvariantEntry {
  readonly questionId: number;
  /** One-based JSONL line. This makes omissions and accidental duplicates reviewable. */
  readonly sourceLine: number;
  readonly family: VideoQaInvariantFamily;
  /** Specific executable behavior selected from this question's video concept. */
  readonly contract: VideoQaBehaviorContract;
}

export interface VideoQaSourceRecord {
  readonly question_id: number;
  readonly title: string;
  readonly question_text: string;
  readonly total_answers: number;
  readonly answers: readonly {
    readonly answer_id: number;
    readonly answer_text: string;
    readonly score: number;
  }[];
}
