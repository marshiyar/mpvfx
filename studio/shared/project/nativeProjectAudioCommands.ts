import {
  parseNativeProjectDocument,
  type NativeProjectClip,
  type NativeProjectDocument,
} from "./nativeProjectDocument";

/** Exact source/timeline alignment required before sound can be folded back in. */
function sameTiming(left: NativeProjectClip, right: NativeProjectClip): boolean {
  return left.startFrame === right.startFrame &&
    left.durationFrames === right.durationFrames &&
    left.sourceInFrame === right.sourceInFrame &&
    (left.sourceInFraction?.numerator ?? 0) * (right.sourceInFraction?.denominator ?? 1) ===
      (right.sourceInFraction?.numerator ?? 0) * (left.sourceInFraction?.denominator ?? 1) &&
    (left.playbackRate?.numerator ?? 1) * (right.playbackRate?.denominator ?? 1) ===
      (right.playbackRate?.numerator ?? 1) * (left.playbackRate?.denominator ?? 1);
}

function allClips(document: NativeProjectDocument): NativeProjectClip[] {
  return document.sequence.tracks.flatMap(track => track.clips);
}

export interface NativeDetachAudioIds {
  assetId: string;
  clipId: string;
  trackId: string;
}

export function createNativeDetachAudioIds(): NativeDetachAudioIds {
  const runtimeCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!runtimeCrypto?.randomUUID) throw new Error("Secure ID generation is unavailable");
  return {
    assetId: `detached-audio-asset:${runtimeCrypto.randomUUID()}`,
    clipId: `detached-audio-clip:${runtimeCrypto.randomUUID()}`,
    trackId: `detached-audio-track:${runtimeCrypto.randomUUID()}`,
  };
}

/**
 * Create a linked audio clip from a video without touching its picture edits.
 * The caller must probe the selected media and pass the verified stream fact.
 * Native export additionally checks the probed stream before encoding.
 */
export function detachNativeVideoAudio(
  source: NativeProjectDocument,
  videoClipId: string,
  hasAudioStream: boolean,
  ids: NativeDetachAudioIds = createNativeDetachAudioIds(),
): NativeProjectDocument {
  if (!hasAudioStream) throw new Error("This video has no audio stream to detach");
  const document = parseNativeProjectDocument(source);
  const video = allClips(document).find(clip => clip.id === videoClipId);
  if (!video) throw new Error(`Video clip ${videoClipId} was not found`);
  const asset = document.assets.find(item => item.id === video.assetId);
  if (asset?.kind !== "video" || !asset.source) throw new Error("Only a video file can have its audio detached");
  if (allClips(document).some(clip => clip.audioDetachedFrom === videoClipId)) {
    throw new Error("This video's audio is already detached");
  }
  if (document.assets.some(item => item.id === ids.assetId) ||
      document.sequence.tracks.some(track => track.id === ids.trackId) ||
      allClips(document).some(clip => clip.id === ids.clipId)) {
    throw new Error("Detached audio IDs already exist in this project");
  }
  const audioParameters = Object.fromEntries(Object.entries(video.staticParameters ?? {})
    .filter(([key]) => key.startsWith("audio.")));
  const audioClip: NativeProjectClip = {
    id: ids.clipId,
    assetId: ids.assetId,
    audioDetachedFrom: video.id,
    ...(video.audioGroupId ? { audioGroupId: video.audioGroupId } : {}),
    ...(video.audioFxChain ? { audioFxChain: video.audioFxChain } : {}),
    ...(video.audioAutomation ? { audioAutomation: video.audioAutomation } : {}),
    startFrame: video.startFrame,
    durationFrames: video.durationFrames,
    sourceInFrame: video.sourceInFrame,
    ...(video.sourceInFraction ? { sourceInFraction: { ...video.sourceInFraction } } : {}),
    playbackRate: { ...video.playbackRate! },
    muted: video.muted,
    staticParameters: audioParameters,
    effects: [],
    parameterTracks: video.parameterTracks.filter(track => track.parameterId.startsWith("audio.")),
  };
  video.muted = true;
  delete video.audioGroupId;
  delete video.audioFxChain;
  delete video.audioAutomation;
  video.parameterTracks = video.parameterTracks.filter(track => !track.parameterId.startsWith("audio."));
  document.assets.push({ id: ids.assetId, kind: "audio", name: `${asset.name} audio`, source: asset.source,
    durationFrames: asset.durationFrames });
  const nextDisplayTrack = Math.max(-1, ...document.sequence.tracks.map((track, index) => track.lane?.displayTrack ?? index)) + 1;
  const nextAuthoredAudioTrack = Math.max(-1, ...document.sequence.tracks.filter(track => track.kind === "audio")
    .map((track, index) => track.lane?.authoredTrack ?? index)) + 1;
  document.sequence.tracks.push({
    id: ids.trackId, kind: "audio",
    lane: { authoredTrack: nextAuthoredAudioTrack, displayTrack: nextDisplayTrack },
    clips: [audioClip],
  });
  return parseNativeProjectDocument(document);
}

/**
 * Reattach only while the two clips still describe the same source interval.
 * A moved/trimmed/rate-edited audio clip remains intact and gets a clear refusal
 * instead of silently losing its edit. Gain, mute and group membership transfer.
 */
export function reattachNativeVideoAudio(source: NativeProjectDocument, audioClipId: string): NativeProjectDocument {
  const document = parseNativeProjectDocument(source);
  const audioTrack = document.sequence.tracks.find(track => track.clips.some(clip => clip.id === audioClipId));
  const audio = audioTrack?.clips.find(clip => clip.id === audioClipId);
  if (!audio?.audioDetachedFrom) throw new Error("This clip is not linked to detached video audio");
  const video = allClips(document).find(clip => clip.id === audio.audioDetachedFrom);
  const audioAsset = document.assets.find(asset => asset.id === audio.assetId);
  const videoAsset = document.assets.find(asset => asset.id === video?.assetId);
  if (!video || videoAsset?.kind !== "video" || audioAsset?.kind !== "audio" ||
      !videoAsset.source || audioAsset.source !== videoAsset.source) {
    throw new Error("The detached audio's source video is no longer available");
  }
  if (allClips(document).filter(clip => clip.audioDetachedFrom === video.id).length !== 1) {
    throw new Error("More than one audio clip links to this video; reattach is ambiguous");
  }
  if (!sameTiming(video, audio)) {
    throw new Error("The detached audio or video was moved, trimmed, or retimed; align them before reattaching");
  }
  if (Object.keys(audio.staticParameters ?? {}).some(key => !key.startsWith("audio."))) {
    throw new Error("The detached audio has edits that cannot be transferred safely to the video");
  }
  const videoEffectIds = new Set(video.effects.map(effect => effect.id));
  const videoParameterIds = new Set(video.parameterTracks.map(track => track.parameterId));
  if (audio.effects.some(effect => videoEffectIds.has(effect.id)) ||
      audio.parameterTracks.some(track => videoParameterIds.has(track.parameterId))) {
    throw new Error("The detached audio has an effect or automation identity that conflicts with the video");
  }
  video.muted = audio.muted;
  video.staticParameters = { ...video.staticParameters, ...audio.staticParameters };
  video.effects.push(...audio.effects);
  video.parameterTracks.push(...audio.parameterTracks);
  if (audio.audioGroupId) video.audioGroupId = audio.audioGroupId;
  else delete video.audioGroupId;
  if (audio.audioFxChain) video.audioFxChain = audio.audioFxChain;
  else delete video.audioFxChain;
  if (audio.audioAutomation) video.audioAutomation = audio.audioAutomation;
  else delete video.audioAutomation;
  audioTrack!.clips = audioTrack!.clips.filter(clip => clip.id !== audio.id);
  if (!audioTrack!.clips.length) document.sequence.tracks = document.sequence.tracks.filter(track => track !== audioTrack);
  if (!allClips(document).some(clip => clip.assetId === audio.assetId)) {
    document.assets = document.assets.filter(asset => asset.id !== audio.assetId);
  }
  return parseNativeProjectDocument(document);
}
