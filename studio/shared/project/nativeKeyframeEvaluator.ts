import type {
  NativeParameterTrack,
  NativeParameterValueMap,
  NativeValueType,
} from "./nativeKeyframeTypes";
import { vkfEngine } from "../engine/vkfEngine";

/**
 * Frame evaluator shared by interactive preview, frame-by-frame export and
 * editing commands. The C++ video-keyframing engine owns the interpolation;
 * this adapter only enforces the project's integral frame addressing so every
 * caller asks the engine for the same sample.
 */
export const evaluateNativeParameterTrack = <K extends NativeValueType>(
  track: NativeParameterTrack<K>,
  projectFrame: number,
): NativeParameterValueMap[K] => {
  if (!Number.isInteger(projectFrame)) {
    throw new TypeError("Native keyframes must be evaluated at an integer project frame");
  }
  if (track.keyframes.length === 0) {
    throw new TypeError(`Native parameter track ${track.id} has no keyframes`);
  }
  return vkfEngine().evaluate(track, projectFrame) as NativeParameterValueMap[K];
};
