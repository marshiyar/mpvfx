import type { NativeProjectDocument } from "./nativeProjectDocument";
import type { NativeInterpolation } from "./nativeKeyframeTypes";
import { planNativePropertyEdit, resolveNativeClipSelection, type NativePropertyEditPlanRequest } from "./nativePropertyEditPlan";
import { applyNativeProjectPropertyCommand, type NativeProjectAtomicPropertyCommand } from "./nativeProjectPropertyCommands";
import { routedPosition } from "./nativeProjectKeyframeCommands";

export interface NativeRecordedKeyframe {
  readonly percentage: number;
  readonly properties: Readonly<Record<string, number | string>>;
  /** Easing of the segment arriving at this sample (velocity-fitter convention). */
  readonly ease?: string;
}

function interpolation(ease: string | undefined): NativeInterpolation {
  if (!ease || ease === "none") return { type: "linear" };
  // The gesture velocity fitter emits this cubic format. Reject unknown easing
  // rather than substituting a different trajectory.
  const match = /^custom\(M0,0 C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) 1,1\)$/.exec(ease);
  if (!match) throw new Error("Unsupported recorded gesture easing");
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  return { type: "cubic-bezier", controlPoints: { x1: x1!, y1: y1!, x2: x2!, y2: y2! } };
}

/** Replace the recorded interval atomically, preserving other properties and keys. */
export function applyNativeGestureRecording(
  document: NativeProjectDocument,
  request: Omit<NativePropertyEditPlanRequest, "properties" | "intent">,
  duration: number,
  keys: readonly NativeRecordedKeyframe[],
): NativeProjectDocument {
  if (!Number.isFinite(duration) || duration <= 0 || keys.length < 2)
    throw new Error("A recording requires a positive duration and at least two samples");
  const resolved = resolveNativeClipSelection(document, request.selectedElement);
  if (!resolved.ok) throw new Error(resolved.failure.message);
  const clip = resolved.located.clip;
  const samples = new Map<string, NativeProjectAtomicPropertyCommand[]>();
  const incoming = new Map<string, NativeInterpolation>();
  const ranges = new Map<string, { first: number; last: number }>();
  let previous = -1;
  for (const key of keys) {
    if (!Number.isFinite(key.percentage) || key.percentage < previous || key.percentage < 0 || key.percentage > 100)
      throw new Error("Recorded samples must be ordered within the recording interval");
    previous = key.percentage;
    const plan = planNativePropertyEdit(document, {
      ...request, intent: "keyframe", properties: key.properties,
      playheadSeconds: request.playheadSeconds + duration * key.percentage / 100,
    });
    if (!plan.ok) throw new Error(plan.failure.message);
    const arrival = interpolation(key.ease);
    const outgoing: NativeInterpolation = { type: "linear" };
    for (const command of plan.command.commands) {
      if (command.type !== "upsert" && command.type !== "update-value")
        throw new Error("Recording must produce native keyframes");
      const id = command.address.parameterId;
      const range = ranges.get(id);
      ranges.set(id, { first: Math.min(range?.first ?? command.frame, command.frame), last: command.frame });
      const upsert: NativeProjectAtomicPropertyCommand = command.type === "upsert" ? { ...command, outgoing } : {
        type: "upsert", address: command.address, frame: command.frame,
        valueType: "number", value: command.value as number, baselineValue: command.value as number, outgoing,
      };
      incoming.set(JSON.stringify([id, command.frame]), arrival);
      samples.set(JSON.stringify([id, command.frame]), [upsert, { type: "set-outgoing", address: command.address, frame: command.frame, outgoing }]);
    }
  }
  // Resolve frame collisions first, then transfer each retained destination's
  // incoming ease to its preceding key on the same parameter track.
  const preceding = new Map<string, NativeProjectAtomicPropertyCommand[]>();
  for (const [sampleId, pair] of samples) {
    const current = pair[0]!;
    const prior = preceding.get(current.address.parameterId);
    if (prior) {
      const outgoing = incoming.get(sampleId)!;
      for (let index = 0; index < prior.length; index++) {
        const command = prior[index]!;
        if (command.type === "upsert" || command.type === "set-outgoing")
          prior[index] = { ...command, outgoing };
      }
    }
    preceding.set(current.address.parameterId, pair);
  }
  const commands = [...samples.values()].flat();
  const deletes: NativeProjectAtomicPropertyCommand[] = [];
  const cleared = new Set<string>();
  for (const [parameterId, range] of ranges) {
    const routed = routedPosition(clip, parameterId);
    if (routed && (!ranges.has("transform.position.x") || !ranges.has("transform.position.y")))
      throw new Error("Recording a 2D motion path requires both position components");
    const track = routed?.track ?? clip.parameterTracks.find(t => t.parameterId === parameterId);
    if (!track || cleared.has(track.id)) continue;
    cleared.add(track.id);
    const frames = track.keyframes.filter(k => k.frame >= range.first && k.frame <= range.last).map(k => k.frame);
    if (frames.length) deletes.push({ type: "delete-many", address: {
      sequenceId: document.sequence.id, trackId: resolved.located.trackId, clipId: clip.id, parameterId: track.parameterId,
    }, frames });
  }
  // Keep a vec2 track present while replacing its keys: inserting first prevents
  // deletion of its last original key from changing the track's representation.
  const result = applyNativeProjectPropertyCommand(document, { type: "batch", commands: [
    ...commands,
    ...deletes.map(command => command.type === "delete-many" ? { ...command,
      frames: command.frames.filter(frame => !commands.some(c => c.type === "upsert" && c.frame === frame &&
        (c.address.parameterId === command.address.parameterId ||
          (command.address.parameterId === "transform.position" && c.address.parameterId.startsWith("transform.position."))))),
    } : command).filter(command => command.type !== "delete-many" || command.frames.length > 0),
  ] });
  if (!result.ok) throw new Error(result.failure.message);
  // A recorded trajectory replaces spatial handles on its authored segments.
  // Retaining old Bezier handles would bend the newly recorded samples.
  const positionFrames = new Set(commands.filter(c => c.type === "upsert" && c.address.parameterId === "transform.position.x").map(c => c.type === "upsert" ? c.frame : -1));
  return {
    ...result.document,
    sequence: { ...result.document.sequence, tracks: result.document.sequence.tracks.map(track => ({
      ...track, clips: track.clips.map(candidate => candidate.id !== clip.id ? candidate : ({
        ...candidate, parameterTracks: candidate.parameterTracks.map(parameter => parameter.parameterId !== "transform.position" ? parameter : ({
          ...parameter, keyframes: parameter.keyframes.map(key => {
            if (!positionFrames.has(key.frame)) return key;
            const { outgoingPath: _path, ...recorded } = key;
            return recorded;
          }),
        })),
      })),
    })) },
  };
}
