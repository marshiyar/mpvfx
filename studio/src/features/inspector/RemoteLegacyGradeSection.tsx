import { useState } from "react";
import { HF_COLOR_GRADING_GRADE_PRESETS, normalizeHfColorGrading } from "@hyperframes/core/color-grading";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";

interface Props {
  selection: PreviewElementState;
  commit: (selection: PreviewElementState, presetId: string | null) => Promise<boolean>;
}

/** Preset-only grading for HTML-rendered legacy projects; source owns the full value. */
export function RemoteLegacyGradeSection({ selection, commit }: Props) {
  const observed = normalizeHfColorGrading(selection.dataAttributes["color-grading"]);
  const [presetId, setPresetId] = useState(observed?.preset ?? "");
  const [busy, setBusy] = useState(false);
  if (selection.tag !== "video" && selection.tag !== "img") return null;
  return <section className="mt-5 space-y-2 border-t border-neutral-700 pt-4" aria-label="Legacy color grade">
    <h3 className="font-medium">Color grade</h3>
    <p className="text-xs text-neutral-500">Preset edits apply to this source image or video.</p>
    <label className="block text-xs">Grade preset
      <select aria-label="Grade preset" value={presetId} onChange={event => setPresetId(event.target.value)}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2">
        <option value="">None</option>
        {HF_COLOR_GRADING_GRADE_PRESETS.map(preset => <option key={preset.id} value={preset.id}>
          {preset.label}</option>)}
      </select>
    </label>
    <button type="button" disabled={busy} onClick={() => {
      setBusy(true);
      void commit(selection, presetId || null).finally(() => setBusy(false));
    }} className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">
      Save color grade
    </button>
  </section>;
}
