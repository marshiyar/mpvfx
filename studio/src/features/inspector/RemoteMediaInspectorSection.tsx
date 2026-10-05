import { useEffect, useState } from "react";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import type { RemoteNativeMediaCommand, RemoteNativeMediaSnapshot } from "../project/remoteInspectorNativeMediaTransaction";

interface RemoteMediaInspectorSectionProps {
  selection: PreviewElementState;
  media: RemoteNativeMediaSnapshot;
  commit: (selection: PreviewElementState, command: RemoteNativeMediaCommand) => Promise<boolean>;
}

/** Saved native media fields; each button makes one sidecar and markup history entry. */
export function RemoteMediaInspectorSection({ selection, media, commit }: RemoteMediaInspectorSectionProps) {
  const [gain, setGain] = useState(String(media.gain));
  const [rate, setRate] = useState(String(media.playbackRate));
  const [sourceStart, setSourceStart] = useState(String(media.sourceStartSeconds));
  const [start, setStart] = useState(String(media.startSeconds));
  const [duration, setDuration] = useState(String(media.durationSeconds));
  const [fxChain, setFxChain] = useState(media.audioFxChain ?? "");
  const [automation, setAutomation] = useState(media.audioAutomation ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setGain(String(media.gain));
    setRate(String(media.playbackRate));
    setSourceStart(String(media.sourceStartSeconds));
    setStart(String(media.startSeconds));
    setDuration(String(media.durationSeconds));
    setFxChain(media.audioFxChain ?? "");
    setAutomation(media.audioAutomation ?? "");
  }, [media.clipId, media.gain, media.playbackRate, media.sourceStartSeconds,
    media.startSeconds, media.durationSeconds, media.audioFxChain, media.audioAutomation]);
  const save = async (command: RemoteNativeMediaCommand) => {
    setBusy(true);
    try { await commit(selection, command); }
    finally { setBusy(false); }
  };
  const numericField = (label: string, value: string, setValue: (next: string) => void,
    command: (number: number) => RemoteNativeMediaCommand, min: number, max: number) =>
    <label className="block text-xs">{label}
      <div className="mt-1 flex gap-2">
        <input aria-label={label} type="number" step="any" min={min} max={max} value={value}
          onChange={event => setValue(event.target.value)}
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 p-2" />
        <button type="button" aria-label={`Save ${label}`} disabled={busy || !value.trim() ||
          !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max}
          onClick={() => void save(command(Number(value)))}
          className="rounded border border-neutral-700 px-2 text-xs disabled:opacity-50">Save</button>
      </div>
    </label>;
  return <section className="mt-5 space-y-3 border-t border-neutral-700 pt-4" aria-label="Native media">
    <h3 className="font-medium">Media · {media.assetKind}</h3>
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" aria-label="Mute media" checked={media.muted} disabled={busy}
        onChange={event => void save({ kind: "muted", value: event.target.checked })} />
      Muted
    </label>
    {numericField("Audio gain", gain, setGain, value => ({ kind: "gain", value }), 0, 2)}
    {numericField("Playback rate", rate, setRate, value => ({ kind: "playback-rate", value }), 0.01, 16)}
    {numericField("Source start (seconds)", sourceStart, setSourceStart,
      value => ({ kind: "source-start", value }), 0, 1000000)}
    <div className="grid grid-cols-2 gap-2">
      <label className="block text-xs">Timeline start (seconds)
        <input aria-label="Timeline start" type="number" step="any" min="0" value={start}
          onChange={event => setStart(event.target.value)}
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
      </label>
      <label className="block text-xs">Duration (seconds)
        <input aria-label="Media duration" type="number" step="any" min="0.001" value={duration}
          onChange={event => setDuration(event.target.value)}
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
      </label>
    </div>
    <button type="button" disabled={busy || !start.trim() || !duration.trim() ||
      !Number.isFinite(Number(start)) || !Number.isFinite(Number(duration)) ||
      Number(start) < 0 || Number(duration) <= 0}
      onClick={() => void save({ kind: "trim", startSeconds: Number(start), durationSeconds: Number(duration) })}
      className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">Save timeline range</button>
    <label className="block text-xs">Audio FX chain
      <textarea aria-label="Audio FX chain" maxLength={65536} value={fxChain}
        onChange={event => setFxChain(event.target.value)} rows={3}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
    </label>
    <button type="button" disabled={busy} onClick={() => void save({ kind: "audio-fx-chain", value: fxChain || null })}
      className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">Save audio FX</button>
    <label className="block text-xs">Audio automation
      <textarea aria-label="Audio automation" maxLength={65536} value={automation}
        onChange={event => setAutomation(event.target.value)} rows={3}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />
    </label>
    <button type="button" disabled={busy} onClick={() => void save({ kind: "audio-automation", value: automation || null })}
      className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">Save automation</button>
  </section>;
}
