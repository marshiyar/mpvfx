import { describe, expect, it } from "vitest";

import {
  VIDEO_QA_BEHAVIOR_CONTRACTS,
  VIDEO_QA_CONTRACT_FAMILY,
  VIDEO_QA_INVARIANT_FAMILIES,
  type VideoQaBehaviorContract,
} from "./videoQaContractTypes";
import { loadVideoQaCorpus } from "./videoQaCorpus";
import { VIDEO_QA_INVARIANT_MAP } from "./videoQaInvariantMap";

const corpus = loadVideoQaCorpus();

/**
 * A deliberately small vocabulary guard. It cannot replace review, but it
 * prevents an unrelated title from being assigned to a convenient contract
 * merely to make the matrix exhaustive.
 */
const CONTRACT_EVIDENCE_PATTERN: Readonly<Record<VideoQaBehaviorContract, RegExp>> = {
  "animation-keyframe-interpolation": /animat|key.?frame|interpolat|rotation|morph|transform|storyboard|rigged|time series data|velocity|gravity/iu,
  "audio-automation-split": /audio|volume|gain|mute|fade|split|merge/iu,
  "audio-video-sync": /audio|sound|sync|voice|music|sample|mux|both inputs|aac track/iu,
  "caption-timing": /caption|subtitle|\bsrt\b|\bvtt\b|text overlay|overlay.{0,10}text|drawtext/iu,
  "codec-container-compatibility": /codec|container|format|encod|transcod|convert|\bmp4\b|\bmov\b|webm|mpeg|prores|\bavi\b|\bmkv\b|\bflv\b|h\.?26[45]|avoptions?|mux|demux|header|x264|key.?frame|i.?frames?|\bgop\b/iu,
  "compositing-pixel-stability": /composit|blend|overlay|alpha|pixel|image|texture|canvas|webgl|opengl|render|layer|color|shader|superimpos|background|tunnel|interpolat|normal|shad|light|surface|triangle|varying|mesh|skeletal|bone|collada|\bfbx\b|depth|artifact/iu,
  "decoder-probe-failure": /decod|probe|invalid data|corrupt|faulty input|no (?:video )?frame|first frame|invisible frame|read video|open video|compressed frame|artifact|parse.{0,20}packet|raw.{0,20}plane/iu,
  "export-alpha-color": /alpha|transparen|color|background|pixel format/iu,
  "export-bitrate-size": /bit.?rate|file size|output size|quality|bandwidth/iu,
  "export-codec-policy": /encod|export|transcod|convert|codec|output format|frame drop/iu,
  "export-resolution-limit": /resolution|dimension|scale|\b[48]k\b|720p|1080p/iu,
  "frame-rate-timebase": /frame.?rate|\bfps\b|time.?base|duration|timestamp|\bpts\b|timecode|playback speed|shifted timestamp|negative.{0,12}time|bogus frame|drop(?:ped|ping)?.{0,10}frames?|duplicated frames|number of frames|minterpolate/iu,
  "hardware-acceleration-policy": /hardware|\bgpu\b|cuda|videotoolbox|dxva|d3d|vaapi|nvenc|\bqsv\b|metal/iu,
  "media-import-classification": /raw|detect|classif|mime|extension|file type|rgb/iu,
  "platform-capability-boundary": /avfoundation|avasset|avlibs?|avformat|gstreamer|media source|android|\bios\b|macos|windows|linux|node|python|moviepy|opencv|directx|webrtc|browser|runtime|\bapi\b|library|compil|linker|entry point|service|server application|framework|docker|lambda|cloud|google function|\bgcs\b|\bs3\b|spring|nestjs|blackmagic|installation|non-interactive|flash|jquery|\bphp\b|golang|\bc\+\+/iu,
  "playback-pause-reseek": /seek|playback|pause|scrub|position|exact start|time.?accurate|frame.?accurate|individual frame|timestamp|stepbackward|playreverse|browse through|jump around.{0,12}frame/iu,
  "render-cancellation-cleanup": /cancel|abort|disconnect|quit|stop|kill|hang|stall|freeze|never finish|cleanup|deadlock|end event/iu,
  "resource-worker-budget": /worker|thread|memory|buffer|pipe|stdin|stdout|subprocess|resource|fork|spawn|popen|cloud.?function|asynch|multiple output|also output|avoid copying|optimizing/iu,
  "stream-manifest-rejection": /\bhls\b|\bdash\b|m3u8|manifest|playlist|segment|\.ismc?\b/iu,
  "stream-timestamp-continuity": /stream|fragment|rtsp|rtmp|\brtp\b|\btcp\b|\budp\b|websocket|webrtc|live|latency|network|pipe|stdout|server|socket|broadcast|youtube|buffer|missing frame|\bmoof\b|chunk|output to a url/iu,
  "thumbnail-frame-extraction": /thumbnail|screenshot|captur|extract.{0,20}frame|output frames|first frame|1st frame|still image|still photo|poster|keyframe.{0,16}\.jpg|keyframes identification|frame naming|decode.{0,20}keyframe|pulling.{0,20}keyframes|keyframes extracted|remove.{0,20}(?:non-)?keyframes|blurred keyframes|keyframes from|get number of keyframes/iu,
  "timeline-edit-integrity": /concat|combine|merg|sequence|track|timeline|append|multiple clip|segment|replace.{0,20}(?:snippet|part)|remove parts|frame manipulation|index/iu,
  "transform-canvas-geometry": /transform|scale|crop|rotate|position|aspect|perspective|coordinate|geometry|vertex|projection|resize|trapezoid|sprite|skinning|weights|matrix|polyline|terrain|triangular surface/iu,
  "trim-split-boundary": /trim|split|cut|segment|start time|end time|copy a part|precisely|accurate.{0,20}(?:cut|part)|extract.{0,20}(?:part|section)|remove.{0,20}(?:opening|ending|parts?|keyframe)|drop.{0,10}parts|join|dividing/iu,
};

describe("video Q&A corpus traceability", () => {
  it("loads all 593 structurally valid source questions", () => {
    expect(corpus).toHaveLength(593);
    expect(corpus.every((record) => (
      Number.isSafeInteger(record.question_id)
      && record.question_id > 0
      && typeof record.title === "string"
      && typeof record.question_text === "string"
      && Array.isArray(record.answers)
    ))).toBe(true);
  });

  it("contains no duplicate source question IDs", () => {
    const ids = corpus.map((record) => record.question_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps answer metadata structurally valid without treating answers as truth", () => {
    for (const record of corpus) {
      expect(record.total_answers).toBe(record.answers.length);
      expect(record.answers.every((answer) => (
        Number.isSafeInteger(answer.answer_id)
        && typeof answer.answer_text === "string"
        && Number.isFinite(answer.score)
      ))).toBe(true);
    }
  });

  it("maps every source question exactly once without inventing IDs", () => {
    const sourceIds = corpus.map((record) => record.question_id).sort((a, b) => a - b);
    const mappedIds = VIDEO_QA_INVARIANT_MAP
      .map((entry) => entry.questionId)
      .sort((a, b) => a - b);

    expect(VIDEO_QA_INVARIANT_MAP).toHaveLength(corpus.length);
    expect(new Set(mappedIds).size).toBe(mappedIds.length);
    expect(mappedIds).toEqual(sourceIds);
  });

  it("keeps each mapping pinned to its original JSONL line", () => {
    for (const entry of VIDEO_QA_INVARIANT_MAP) {
      expect(corpus[entry.sourceLine - 1]?.question_id).toBe(entry.questionId);
    }
  });

  it("uses every native video-editor invariant family", () => {
    const represented = new Set(VIDEO_QA_INVARIANT_MAP.map((entry) => entry.family));
    expect([...represented].sort()).toEqual([...VIDEO_QA_INVARIANT_FAMILIES].sort());
  });

  it("maps every row to a represented executable behavior contract", () => {
    const represented = new Set(VIDEO_QA_INVARIANT_MAP.map((entry) => entry.contract));
    expect([...represented].sort()).toEqual([...VIDEO_QA_BEHAVIOR_CONTRACTS].sort());
    for (const entry of VIDEO_QA_INVARIANT_MAP) {
      expect(entry.family).toBe(VIDEO_QA_CONTRACT_FAMILY[entry.contract]);
    }
  });

  it("does not name proxy contracts for production behaviors the editor does not implement", () => {
    expect(VIDEO_QA_BEHAVIOR_CONTRACTS).not.toContain("codec-gop-random-access");
    expect(VIDEO_QA_BEHAVIOR_CONTRACTS).not.toContain("frame-synthesis-interpolation");
  });

  it("requires each mapped question—not its answers—to name a concept belonging to its behavior", () => {
    const mismatches = VIDEO_QA_INVARIANT_MAP
      .filter((entry) => {
        const source = corpus[entry.sourceLine - 1]!;
        const questionOnly = `${source.title}\n${source.question_text}`;
        return !CONTRACT_EVIDENCE_PATTERN[entry.contract].test(questionOnly);
      })
      .map(
        (entry) => `line ${entry.sourceLine} / ${entry.questionId} -> ${entry.contract}`,
      );
    expect(mismatches).toEqual([]);
  });

  it("does not turn CSS or HTML implementation advice into a test family", () => {
    expect(VIDEO_QA_INVARIANT_FAMILIES.every((family) => !/(?:css|html)/iu.test(family))).toBe(true);
  });
});
