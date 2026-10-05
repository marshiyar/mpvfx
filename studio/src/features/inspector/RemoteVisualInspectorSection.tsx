import { useEffect, useState } from "react";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import type { PatchOperation } from "../legacy/sourcePatcher";
import { REMOTE_VISUAL_FIELDS, validRemoteVisualStyle } from "./remoteVisualFields";

interface Props {
  selection: PreviewElementState;
  commit: (selection: PreviewElementState, operations: PatchOperation[], label: string) => Promise<boolean>;
}

/** Optional visual styles, all constrained to literal CSS values without URLs or expressions. */
export function RemoteVisualInspectorSection({ selection, commit }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValues(Object.fromEntries(REMOTE_VISUAL_FIELDS.map(field =>
      [field.property, selection.inlineStyles[field.property] ?? ""])));
  }, [selection]);
  const operations: PatchOperation[] = REMOTE_VISUAL_FIELDS.flatMap(field => {
    const next = values[field.property] ?? "";
    if (next === (selection.inlineStyles[field.property] ?? "")) return [];
    return [{ type: "inline-style", property: field.property, value: next || null }];
  });
  const valid = operations.every(operation => validRemoteVisualStyle(operation.property, operation.value));
  return <section className="mt-5 space-y-3 border-t border-neutral-700 pt-4" aria-label="Visual style">
    <h3 className="font-medium">Visual style</h3>
    {REMOTE_VISUAL_FIELDS.map(field => <label key={field.property} className="block text-xs">{field.label}
      {"options" in field ? <select aria-label={field.label} value={values[field.property] ?? ""}
        onChange={event => setValues(current => ({ ...current, [field.property]: event.target.value }))}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2">
        <option value="">Source default</option>
        {field.options.map(value => <option key={value} value={value}>{value}</option>)}
      </select> : <input aria-label={field.label} maxLength={128} value={values[field.property] ?? ""}
        placeholder={field.placeholder}
        onChange={event => setValues(current => ({ ...current, [field.property]: event.target.value }))}
        className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 p-2" />}
    </label>)}
    <button type="button" disabled={busy || operations.length === 0 || !valid}
      onClick={() => {
        setBusy(true);
        void commit(selection, operations, "Edit visual style").finally(() => setBusy(false));
      }} className="rounded border border-neutral-700 px-3 py-2 text-xs disabled:opacity-50">
      Save visual style
    </button>
  </section>;
}
