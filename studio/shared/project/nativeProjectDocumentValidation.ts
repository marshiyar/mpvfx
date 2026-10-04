/** Complete diagnostics for untrusted native project documents. */
import { type RationalFrameRate } from "./nativeKeyframeTypes";
import {
  DEFAULT_NATIVE_PLAYBACK_RATE,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  type NativePlaybackRate,
  type NativeProjectDocumentValidationIssue,
} from "./nativeProjectDocumentTypes";
import {
  type RecordValue,
  isRecord, isNonEmptyString, isNonNegativeInteger, isPositiveInteger,
  validateTrackLane, pushIssue, requireId, collectDuplicateId, validateFrameRate,
  validatePlaybackRate, sourceRangeExceedsAsset, validateParameterTracks,
  validateStaticParameters, validateClipBinding,
} from "./nativeProjectDocumentValidationHelpers";

export function validateNativeProjectDocument(
  input: unknown,
): NativeProjectDocumentValidationIssue[] {
  const issues: NativeProjectDocumentValidationIssue[] = [];
  if (!isRecord(input)) {
    pushIssue(issues, "invalid-root", "", "Project document must be an object");
    return issues;
  }

  if (input.schemaVersion !== NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION) {
    pushIssue(
      issues,
      "unsupported-schema-version",
      "schemaVersion",
      `Project schemaVersion must be ${NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION}`,
    );
  }
  if (input.mediaEngine !== undefined && input.mediaEngine !== "ffmpeg") {
    pushIssue(issues, "invalid-root", "mediaEngine", "Unknown media engine");
  }
  requireId(input.id, "id", issues);
  if (!isNonNegativeInteger(input.revision)) {
    pushIssue(issues, "invalid-revision", "revision", "Revision must be a non-negative integer");
  }
  const projectFrameRate = validateFrameRate(input.frameRate, "frameRate", issues)
    ? input.frameRate
    : null;

  if (!isRecord(input.canvas)) {
    pushIssue(issues, "invalid-canvas", "canvas", "Canvas must be an object");
  } else {
    if (!isPositiveInteger(input.canvas.width)) {
      pushIssue(issues, "invalid-canvas", "canvas.width", "Canvas width must be a positive integer");
    }
    if (!isPositiveInteger(input.canvas.height)) {
      pushIssue(issues, "invalid-canvas", "canvas.height", "Canvas height must be a positive integer");
    }
    if (!isNonEmptyString(input.canvas.background)) {
      pushIssue(issues, "invalid-canvas", "canvas.background", "Canvas background must be a non-empty string");
    }
  }

  const assetsById = new Map<string, RecordValue>();
  if (!Array.isArray(input.assets)) {
    pushIssue(issues, "invalid-asset", "assets", "Assets must be an array");
  } else {
    const assetIds = new Set<string>();
    input.assets.forEach((asset, index) => {
      const path = `assets[${index}]`;
      if (!isRecord(asset)) {
        pushIssue(issues, "invalid-asset", path, "Asset must be an object");
        return;
      }
      requireId(asset.id, `${path}.id`, issues);
      collectDuplicateId(assetIds, asset.id, `${path}.id`, issues);
      if (isNonEmptyString(asset.id) && !assetsById.has(asset.id)) assetsById.set(asset.id, asset);
      if (asset.kind !== "video" && asset.kind !== "audio" && asset.kind !== "image" && asset.kind !== "element") {
        pushIssue(issues, "invalid-asset", `${path}.kind`, "Asset kind must be video, audio, image, or element");
      }
      if (asset.kind === "element" && asset.source !== undefined) {
        pushIssue(issues, "invalid-asset", `${path}.source`, "Element assets are authored in HTML and have no source file");
      }
      if (!isNonEmptyString(asset.name)) {
        pushIssue(issues, "invalid-asset", `${path}.name`, "Asset name must be a non-empty string");
      }
      if (asset.source !== undefined && !isNonEmptyString(asset.source)) {
        pushIssue(issues, "invalid-asset", `${path}.source`, "Asset source must be a non-empty string");
      }
      if (!isPositiveInteger(asset.durationFrames)) {
        pushIssue(issues, "invalid-asset", `${path}.durationFrames`, "Asset duration must be a positive integer");
      }
    });
  }

  if (
    input.mediaEngine === "ffmpeg" &&
    Array.isArray(input.assets) &&
    input.assets.some((asset) => isRecord(asset) && asset.kind === "element")
  ) {
    // An HTML-free document has nowhere to author element layers.
    pushIssue(issues, "invalid-asset", "assets", "FFmpeg-only documents cannot contain HTML element layers");
  }

  if (!isRecord(input.sequence)) {
    pushIssue(issues, "invalid-track", "sequence", "Sequence must be an object");
    return issues;
  }
  requireId(input.sequence.id, "sequence.id", issues);
  if (!isNonEmptyString(input.sequence.name)) {
    pushIssue(issues, "invalid-track", "sequence.name", "Sequence name must be a non-empty string");
  }
  if (input.sequence.durationFrames !== undefined && !isPositiveInteger(input.sequence.durationFrames)) {
    pushIssue(issues, "invalid-track", "sequence.durationFrames", "Sequence duration must be a positive integer");
  }
  if (!Array.isArray(input.sequence.tracks)) {
    pushIssue(issues, "invalid-track", "sequence.tracks", "Tracks must be an array");
    return issues;
  }

  const audioGroupIds = new Set<string>();
  if (input.sequence.audioGroups !== undefined) {
    if (!Array.isArray(input.sequence.audioGroups)) {
      pushIssue(issues, "invalid-track", "sequence.audioGroups", "Audio groups must be an array");
    } else {
      input.sequence.audioGroups.forEach((group, index) => {
        const path = `sequence.audioGroups[${index}]`;
        if (!isRecord(group)) {
          pushIssue(issues, "invalid-track", path, "Audio group must be an object");
          return;
        }
        requireId(group.id, `${path}.id`, issues);
        collectDuplicateId(audioGroupIds, group.id, `${path}.id`, issues);
        if (group.label !== undefined && !isNonEmptyString(group.label)) {
          pushIssue(issues, "invalid-track", `${path}.label`, "Audio group label must be a non-empty string");
        }
        if (group.volume !== undefined &&
            (typeof group.volume !== "number" || !Number.isFinite(group.volume) || group.volume < 0 || group.volume > 10 ** (12 / 20))) {
          pushIssue(issues, "invalid-track", `${path}.volume`, "Audio group gain must be within the supported fader range");
        }
        if (group.muted !== undefined && typeof group.muted !== "boolean") {
          pushIssue(issues, "invalid-track", `${path}.muted`, "Audio group mute must be a boolean");
        }
        for (const name of ["fxChain", "automation"] as const) {
          if (group[name] !== undefined && (typeof group[name] !== "string" || !group[name])) {
            pushIssue(issues, "invalid-track", `${path}.${name}`, `${name} must be serialized text`);
          }
        }
      });
    }
  }

  const trackIds = new Set<string>();
  const authoredLaneIds = new Set<string>();
  const displayLaneIds = new Set<number>();
  const clipIds = new Set<string>();
  const bindingIdentities = new Set<string>();
  input.sequence.tracks.forEach((track, trackIndex) => {
    const trackPath = `sequence.tracks[${trackIndex}]`;
    if (!isRecord(track)) {
      pushIssue(issues, "invalid-track", trackPath, "Track must be an object");
      return;
    }
    requireId(track.id, `${trackPath}.id`, issues);
    collectDuplicateId(trackIds, track.id, `${trackPath}.id`, issues);
    if (track.kind !== "video" && track.kind !== "audio" && track.kind !== "mixed") {
      pushIssue(issues, "invalid-track", `${trackPath}.kind`, "Track kind must be video, audio, or mixed");
    }
    const lane = validateTrackLane(track.lane, trackIndex, `${trackPath}.lane`, issues);
    if (lane) {
      if (displayLaneIds.has(lane.displayTrack)) {
        pushIssue(
          issues,
          "invalid-track",
          `${trackPath}.lane.displayTrack`,
          `Display track ${lane.displayTrack} is already mapped by another native track`,
        );
      } else {
        displayLaneIds.add(lane.displayTrack);
      }
      if (track.kind === "video" || track.kind === "audio" || track.kind === "mixed") {
        const authoredLaneId = `${track.kind}\u0000${lane.authoredTrack}`;
        if (authoredLaneIds.has(authoredLaneId)) {
          pushIssue(
            issues,
            "invalid-track",
            `${trackPath}.lane.authoredTrack`,
            `${track.kind} authored track ${lane.authoredTrack} is already mapped`,
          );
        } else {
          authoredLaneIds.add(authoredLaneId);
        }
      }
    }
    if (!Array.isArray(track.clips)) {
      pushIssue(issues, "invalid-track", `${trackPath}.clips`, "Track clips must be an array");
      return;
    }
    track.clips.forEach((clip, clipIndex) => {
      const clipPath = `${trackPath}.clips[${clipIndex}]`;
      if (!isRecord(clip)) {
        pushIssue(issues, "invalid-clip", clipPath, "Clip must be an object");
        return;
      }
      requireId(clip.id, `${clipPath}.id`, issues);
      collectDuplicateId(clipIds, clip.id, `${clipPath}.id`, issues);
      if (typeof clip.binding !== "undefined") {
        validateClipBinding(clip.binding, `${clipPath}.binding`, bindingIdentities, issues);
      }
      if (!isNonEmptyString(clip.assetId)) {
        pushIssue(issues, "missing-reference", `${clipPath}.assetId`, "Clip assetId must be a non-empty string");
      }
      const asset = isNonEmptyString(clip.assetId) ? assetsById.get(clip.assetId) : undefined;
      if (!asset && isNonEmptyString(clip.assetId)) {
        pushIssue(issues, "missing-reference", `${clipPath}.assetId`, `Missing asset ${clip.assetId}`);
      }
      if (clip.audioGroupId !== undefined) {
        if (!isNonEmptyString(clip.audioGroupId) || !audioGroupIds.has(clip.audioGroupId)) {
          pushIssue(issues, "missing-reference", `${clipPath}.audioGroupId`, "Clip audio group must name a defined bus");
        }
        if (asset && asset.kind !== "audio" && asset.kind !== "video") {
          pushIssue(issues, "invalid-clip", `${clipPath}.audioGroupId`, "Only audio and video clips can join an audio group");
        }
      }
      if (clip.audioDetachedFrom !== undefined &&
          (!isNonEmptyString(clip.audioDetachedFrom) || asset?.kind !== "audio")) {
        pushIssue(issues, "invalid-clip", `${clipPath}.audioDetachedFrom`, "Only an audio clip can link to a source video clip");
      }
      for (const name of ["audioFxChain", "audioAutomation"] as const) {
        if (clip[name] !== undefined && (typeof clip[name] !== "string" || !clip[name])) {
          pushIssue(issues, "invalid-clip", `${clipPath}.${name}`, `${name} must be serialized text`);
        }
      }
      if (
        asset &&
        ((track.kind === "audio" && asset.kind !== "audio") ||
          (track.kind === "video" && asset.kind !== "video" && asset.kind !== "image" && asset.kind !== "element"))
      ) {
        pushIssue(issues, "media-type-mismatch", `${clipPath}.assetId`, "Asset kind does not match track kind");
      }
      for (const [name, value, positive] of [
        ["startFrame", clip.startFrame, false],
        ["durationFrames", clip.durationFrames, true],
        ["sourceInFrame", clip.sourceInFrame, false],
      ] as const) {
        if ((positive ? !isPositiveInteger(value) : !isNonNegativeInteger(value))) {
          pushIssue(
            issues,
            "invalid-clip",
            `${clipPath}.${name}`,
            `${name} must be a ${positive ? "positive" : "non-negative"} integer`,
          );
        }
      }
      const playbackRate =
        typeof clip.playbackRate === "undefined"
          ? DEFAULT_NATIVE_PLAYBACK_RATE
          : validatePlaybackRate(clip.playbackRate, `${clipPath}.playbackRate`, issues)
            ? clip.playbackRate
            : null;
      const fraction = clip.sourceInFraction;
      const validFraction = fraction === undefined || (isRecord(fraction) &&
        isNonNegativeInteger(fraction.numerator) && isPositiveInteger(fraction.denominator) && fraction.numerator < fraction.denominator);
      if (!validFraction) pushIssue(issues, "invalid-clip", `${clipPath}.sourceInFraction`, "Source fraction must be a nonnegative rational smaller than one");
      if (typeof clip.muted !== "undefined" && typeof clip.muted !== "boolean") {
        pushIssue(issues, "invalid-clip", `${clipPath}.muted`, "Muted must be a boolean");
      }
      validateStaticParameters(clip.staticParameters, `${clipPath}.staticParameters`, issues);
      if (
        asset &&
        (asset.kind === "video" || asset.kind === "audio") &&
        isNonNegativeInteger(clip.sourceInFrame) &&
        isPositiveInteger(clip.durationFrames) &&
        isPositiveInteger(asset.durationFrames) &&
        playbackRate &&
        validFraction &&
        sourceRangeExceedsAsset(
          clip.sourceInFrame,
          clip.durationFrames,
          playbackRate,
          asset.durationFrames,
          fraction as NativePlaybackRate | undefined,
        )
      ) {
        pushIssue(
          issues,
          "source-out-of-bounds",
          clipPath,
          "Clip source range exceeds its asset duration",
        );
      }
      if (!Array.isArray(clip.effects)) {
        pushIssue(issues, "invalid-effect", `${clipPath}.effects`, "Effects must be an array");
      } else {
        const effectIds = new Set<string>();
        clip.effects.forEach((effect, effectIndex) => {
          const effectPath = `${clipPath}.effects[${effectIndex}]`;
          if (!isRecord(effect)) {
            pushIssue(issues, "invalid-effect", effectPath, "Effect must be an object");
            return;
          }
          requireId(effect.id, `${effectPath}.id`, issues);
          collectDuplicateId(effectIds, effect.id, `${effectPath}.id`, issues);
          if (!isNonEmptyString(effect.effectId)) {
            pushIssue(issues, "invalid-effect", `${effectPath}.effectId`, "Effect ID must be a non-empty string");
          }
          if (typeof effect.enabled !== "boolean") {
            pushIssue(issues, "invalid-effect", `${effectPath}.enabled`, "Effect enabled must be a boolean");
          }
          if (typeof effect.parameters !== "undefined" && !isRecord(effect.parameters)) {
            pushIssue(issues, "invalid-effect", `${effectPath}.parameters`, "Effect parameters must be an object");
          }
        });
      }
      validateParameterTracks(
        clip.parameterTracks,
        projectFrameRate,
        isPositiveInteger(clip.durationFrames) ? clip.durationFrames : null,
        `${clipPath}.parameterTracks`,
        issues,
      );
    });
  });

  return issues;
}

/** Parse only a fully valid v1 document. Invalid input is never repaired. */
