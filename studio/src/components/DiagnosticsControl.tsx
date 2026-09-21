import { useEffect, useState } from "react";
import { downloadDiagnostics, getDiagnosticStatus, type DiagnosticStatus } from "../diagnostics/client";

export function DiagnosticsControl() {
  const [status, setStatus] = useState<DiagnosticStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { let mounted = true; void getDiagnosticStatus().then((next) => { if (mounted) setStatus(next); }); return () => { mounted = false; }; }, []);
  if (!status) return null;
  return <div className="shrink-0 border-t border-neutral-800/50 p-2 text-xs text-neutral-400">
    <button type="button" data-diagnostic-action="diagnostics-toggle" aria-expanded={open} onClick={() => { setOpen(!open); void getDiagnosticStatus().then(setStatus); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-neutral-800 hover:text-neutral-200">
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${status.recording ? "bg-emerald-500" : "bg-amber-500"}`} />
      {status.recording ? "Diagnostics · recording locally" : "Diagnostics · recording unavailable"}
    </button>
    {open && <div className="space-y-2 px-2 pb-2 pt-1">
      <p>Clicks, errors, crashes and performance stay on this device. Recent logs are kept for up to {status.retentionDays} days.</p>
      <p>Save a report after a problem. Reports omit media, typed text and native memory dumps. Nothing is uploaded by this feature.</p>
      <p className="break-all text-neutral-500">Session: {status.sessionId}</p>
      <button type="button" data-diagnostic-action="diagnostics-export" disabled={saving} onClick={async () => {
        setSaving(true); setError("");
        try { await downloadDiagnostics(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Report could not be saved."); } finally { setSaving(false); }
      }} className="rounded border border-neutral-700 px-3 py-2 text-neutral-100 hover:bg-neutral-800 disabled:opacity-50">{saving ? "Preparing report…" : "Save diagnostic report"}</button>
      {error && <p role="alert" className="text-red-400">{error}</p>}
    </div>}
  </div>;
}
