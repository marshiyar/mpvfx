import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LibraryCommand,
  LibraryView,
} from "../../../shared/library/library";
import { buildProjectHash } from "../../app/projectRouting";
import { safeLocalStorage } from "../../lib/safeStorage";

const control =
  "w-full bg-neutral-900 text-neutral-200 text-xs rounded px-2 py-1.5 disabled:opacity-50";
const button = "text-xs text-neutral-400 hover:text-white disabled:opacity-40";
export function LibraryNavigator({
  projectId,
  beforeSwitch,
  onAddAsset,
}: {
  projectId: string;
  beforeSwitch: () => Promise<void>;
  onAddAsset?: (path: string, placeOnTimeline: boolean) => unknown;
}) {
  const [libraries, setLibraries] = useState<LibraryView[]>([]);
  const [selected, setSelected] = useState("");
  const [eventId, setEventId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState<"event" | "project" | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"managed" | "linked">("managed");
  const mounted = useRef(true);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const active = libraries.find((l) =>
    l.projects.some((p) => p.id === projectId),
  );
  const library =
    libraries.find((l) => l.id === selected) ?? active ?? libraries[0];
  const activeProjectEventId = library?.projects.find((p) => p.id === projectId)?.eventId;
  const event =
    library?.events.find((e) => e.id === eventId) ??
    library?.events.find((e) => e.id === activeProjectEventId) ??
    library?.events[0];
  const switchProject = useCallback(
    async (next: string) => {
      if (next === currentProject.current) return;
      await beforeSwitch();
      safeLocalStorage()?.setItem("mpvfx-active-project", next);
      window.location.hash = buildProjectHash(next);
    },
    [beforeSwitch],
  );
  const refresh = useCallback(async () => {
    const result = await window.mpvfx?.library?.({ type: "list" });
    if (result && mounted.current) setLibraries(result.libraries);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch((e) => setError(String(e)));
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 3000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);
  const run = async (command: LibraryCommand) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const originProject = currentProject.current;
    try {
      const result = await window.mpvfx.library?.(command);
      if (!result || !mounted.current) return;
      setLibraries(result.libraries);
      if (result.errors?.length) setError(result.errors.join("\n"));
      if (result.projectId) {
        setSelected(
          result.libraries.find((l) =>
            l.projects.some((p) => p.id === result.projectId),
          )?.id ?? "",
        );
        await switchProject(result.projectId);
      }
      if (result.path && originProject === currentProject.current) {
        const asset =
          command.type === "attach"
            ? result.libraries
                .find((l) => l.id === command.libraryId)
                ?.assets.find((a) => a.id === command.assetId)
            : undefined;
        await onAddAsset?.(
          result.path,
          !!asset && ["video", "audio", "image"].includes(asset.kind),
        );
      }
      setCreating(null);
      setName("");
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  if (!window.mpvfx?.library) return null;
  return (
    <div
      className="px-3 pt-3 pb-2 space-y-2 text-neutral-300"
      aria-label="Library browser"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Libraries</span>
        <div className="flex gap-3">
          <button
            className={button}
            disabled={busy}
            onClick={() => void run({ type: "create" })}
          >
            New library
          </button>
          <button
            className={button}
            disabled={busy}
            onClick={() => void run({ type: "open" })}
          >
            Open
          </button>
        </div>
      </div>
      {library ? (
        <>
          <select
            aria-label="Library"
            className={control}
            value={library.id}
            disabled={busy}
            onChange={(e) => {
              setSelected(e.target.value);
              setEventId("");
            }}
          >
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <select
              aria-label="Event"
              className={control}
              value={event?.id ?? ""}
              onChange={(e) => setEventId(e.target.value)}
            >
              {library.events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            <button
              className={`${button} shrink-0`}
              disabled={busy}
              onClick={() => setCreating("event")}
            >
              New event
            </button>
          </div>
          <div className="flex items-center gap-2">
            <select
              aria-label="Project"
              className={control}
              value={
                library.projects.some(
                  (p) => p.id === projectId && p.eventId === event?.id,
                )
                  ? projectId
                  : ""
              }
              disabled={busy}
              onChange={(e) => {
                void switchProject(e.target.value).catch((err) =>
                  setError(String(err)),
                );
              }}
            >
              <option value="" disabled>
                Select project
              </option>
              {library.projects
                .filter((p) => p.state === "ready" && p.eventId === event?.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <button
              className={`${button} shrink-0`}
              disabled={busy || !event}
              onClick={() => setCreating("project")}
            >
              New project
            </button>
          </div>
          {creating && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  creating === "event"
                    ? { type: "event", libraryId: library.id, name }
                    : {
                        type: "project",
                        libraryId: library.id,
                        eventId: event!.id,
                        name,
                      },
                );
              }}
            >
              <input
                aria-label={
                  creating === "event" ? "Event name" : "Project name"
                }
                autoFocus
                required
                maxLength={200}
                className={control}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  creating === "event" ? "Event name" : "Project name"
                }
              />
              <button className={button} disabled={busy || !name.trim()}>
                Create
              </button>
              <button
                type="button"
                className={button}
                onClick={() => setCreating(null)}
              >
                Cancel
              </button>
            </form>
          )}
          <details>
            <summary className="text-xs text-neutral-400 cursor-pointer">
              Library media (
              {library.assets.filter((a) => a.state === "ready").length})
            </summary>
            <div className="mt-2 space-y-2">
              <select
                aria-label="Library import storage"
                className={control}
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
              >
                <option value="managed">Copy into library</option>
                <option value="linked">Link to original files</option>
              </select>
              <button
                className={button}
                disabled={busy || !event}
                onClick={() =>
                  void run({
                    type: "import",
                    libraryId: library.id,
                    eventId: event!.id,
                    mode,
                  })
                }
              >
                {busy ? "Working…" : "Import into event…"}
              </button>
              <div className="max-h-40 overflow-auto space-y-2">
                {library.assets
                  .filter((a) => a.eventId === event?.id)
                  .map((a) => (
                    <div key={a.id} className="text-xs flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate" title={a.name}>
                        {a.name}
                        {a.state === "pending"
                          ? " (incomplete)"
                          : !a.available
                            ? " (offline)"
                            : ""}
                      </span>
                      {a.mode === "linked" && !a.available ? (
                        <button
                          className={button}
                          disabled={busy}
                          onClick={() =>
                            void run({
                              type: "relink",
                              libraryId: library.id,
                              assetId: a.id,
                            })
                          }
                        >
                          Relink
                        </button>
                      ) : null}
                      <button
                        className={`${button} shrink-0`}
                        disabled={
                          busy ||
                          !a.available ||
                          a.state !== "ready" ||
                          active?.id !== library.id
                        }
                        onClick={() =>
                          void run({
                            type: "attach",
                            libraryId: library.id,
                            projectId,
                            assetId: a.id,
                          })
                        }
                      >
                        {a.kind === "font"
                          ? "Add to project"
                          : "Add to timeline"}
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          </details>
          {library.jobs.length > 0 && (
            <details>
              <summary className="text-xs text-neutral-400 cursor-pointer">
                Library exports ({library.jobs.length})
              </summary>
              <div className="max-h-32 overflow-auto mt-2 space-y-2">
                {library.jobs.map((job) => (
                  <div key={job.id} className="text-xs flex items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={job.error || job.output}
                    >
                      {
                        library.projects.find((p) => p.id === job.projectId)
                          ?.name
                      }
                      : {job.status}
                    </span>
                    {job.status === "complete" && (
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() =>
                          void run({
                            type: "saveOutput",
                            libraryId: library.id,
                            jobId: job.id,
                          })
                        }
                      >
                        Save as…
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
          <button
            className={`${button} block`}
            onClick={() => void run({ type: "reveal", libraryId: library.id })}
          >
            Show library in Finder
          </button>
        </>
      ) : (
        <p className="text-xs text-neutral-500">
          Your existing project stays available. Create a library to organize
          new projects and shared media.
        </p>
      )}
      {projectId !== "MpVFX" && (
        <button
          className={`${button} block`}
          disabled={busy}
          onClick={() =>
            void switchProject("MpVFX").catch((e) => setError(String(e)))
          }
        >
          Open existing standalone project
        </button>
      )}
      {projectId === "MpVFX" && library && (
        <p className="text-xs text-neutral-500">
          Editing the existing standalone project
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-400 whitespace-pre-wrap">
          {error}
        </p>
      )}
    </div>
  );
}
