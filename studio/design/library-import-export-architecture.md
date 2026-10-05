# Library, import, and export architecture

Status: target architecture, 2026-09-25. The first usable library workflow is implemented in 0.0.6; see `library-implementation-status.md` for delivered behavior, verification, and remaining work. This document distinguishes the intended complete system from that increment. No existing user project is automatically migrated.

## Outcome and scope

A desktop editor with user-chosen libraries, multiple editing projects per library, shared source media, recoverable imports, and exports tied to an exact project revision. Preserve the current canvas, timeline, inspector, keyframes, effects, and media browser. Use native C++ services behind the Electron application. Keep the reusable keyframe engine independent of Electron and storage policy.

Confirmed user preference: copy imported media into the library by default; also offer linked originals. Remember the choice per library. An import never silently moves or deletes the original source file.

## Existing implementation observed in source

- `desktop/projectPaths.ts` puts projects, renders, cache, and sessions under application data.
- `runtime/projects/standaloneProject.ts` creates/selects the default `MpVFX` project.
- `runtime/adapter.ts` discovers projects by directory and HTML entry file. Render outputs use a sibling renders directory.
- `shared/project/nativeProjectDocument.ts` schema 1 has project-local assets, a sequence, stable clip IDs, animation tracks, and optional HTML bindings. Media sources are project-relative paths.
- `runtime/media/localImport.ts` stages local copies and publishes files without sending full media bytes through renderer IPC.
- `runtime/projects/mediaFileOperations.ts` and the file transaction implementation already coordinate reference updates, recovery, and undo for project-local files.
- `runtime/export/nativeProject.ts` materializes compatible HTML/native export views, using hard links or copies. A hard link alone does not isolate an externally mutable source file.
- `runtime/service.ts` serializes project access and tracks render jobs in memory. A durable multi-library catalog/job system must be introduced explicitly.

These mechanisms are migration inputs, not evidence that shared-library ownership already exists. Existing HTML features remain supported through a compatibility adapter until equivalent native behavior is demonstrated.

## Ownership model

```text
Library
  Events (organizational containers)
    Media entries -> library asset IDs
    Projects -> immutable project revisions
      Sequence -> tracks -> clip instances -> asset IDs
  Media catalog -> asset versions -> managed or linked locations
  Background jobs -> imports, analysis, proxies, exports
  History and retained revision/media references
```

An event groups projects and media entries; it does not own a second copy of media bytes. A project initially owns one main sequence, matching the current document. The schema permits additional sequences later without exposing unfinished UI.

Identifiers are opaque, stable IDs. Names, filenames, event membership, paths, and DOM IDs are not identity. A repeated placement creates a new clip ID referring to the same asset. Duplicating a project shares assets and creates a new project identity. Copying between libraries creates an explicit ID mapping and verifies/copies dependencies; it must not silently create cross-library lifetime dependencies.

| Entity | Authoritative information |
| --- | --- |
| Library | ID, schema version, catalog revision, storage policy |
| Event | ID, library ID, display name, ordering |
| Asset | ID, media kind, display name, metadata, current version |
| AssetVersion | ID, asset ID, stream metadata, fingerprint, immutable content identity when verified |
| MediaLocation | Asset version, managed relative location or linked native locator, availability |
| Project | ID, event ID, title, current revision ID |
| ProjectRevision | Immutable sequence, project timebase, canvas/color/audio settings, dependency manifest |
| Clip | ID, asset version reference, placement/source timing, transforms, effects, keyframes |
| Derivative | Asset version, generation recipe/version, proxy/thumbnail/waveform location |
| Job | ID, type, persistent status, input revision, progress, error, cancellation intent |
| ExportArtifact | Job ID, destination, output properties, source revision, verified completion |

Store source timestamps and project time in explicit rational timebases. Do not reinterpret source duration as project frames or assume constant frame rate. Still-image duration belongs to the placement. Audio streams retain sample rate/channel layout independently of video frame rate. C++ remains authoritative for timing and keyframe evaluation.

## Persistence and native service boundary

Proposed bundle layout (macOS package registration is a separate implementation task):

```text
My Film.mpvfxlibrary/
  Library.json                 # format/version/library ID bootstrap
  Catalog.sqlite               # catalog, revisions, history, jobs, dependency edges
  Media/Originals/<version-id>/ # managed immutable originals
  Resources/                   # fonts, LUTs, authored compatibility files
  Cache/                       # regenerable; external cache root permitted
  Staging/<operation-id>/       # unpublished imports and recovery artifacts
  Trash/                       # retained managed media pending safe collection
```

User application data stores preferences, recent-library locators, and session state. A library remains usable after that application data is removed. Export destinations are user-selected and outside the library by default. Catalog metadata records exported artifacts; it does not make those output files managed source media. Backups should be configurable outside the library volume; distinguish metadata backup from a complete media archive.

Build a reusable C++ library service using SQLite's C API, with a narrow versioned bridge to Electron. Keep it separate from the keyframe/math engine. Electron owns OS dialogs and routes commands; the library service owns catalog writes and lifecycle decisions. Codec probing/rendering runs in cancellable workers so expensive work never blocks the Electron main thread. Reuse the existing native bridge where compatible; do not add a second independent catalog writer in TypeScript.

Use SQLite transactions for catalog consistency and foreign keys for ownership/reference integrity. Store project revisions and their dependency rows within the same database transaction. Do not keep a second independently editable project JSON as another authority: JSON becomes import/export/compatibility materialization for migrated libraries. The existing legacy project path keeps its existing authority until migration commits.

Database transactions cannot atomically include filesystem copies. Each media operation therefore has a persisted intent and recovery state. Stage/copy/probe outside the short catalog write transaction, make bytes durable, publish to an immutable unique location, then commit the catalog reference. A crash between publication and catalog commit leaves a recoverable orphan, not a ready asset pointing at a partial file. Startup reconciles intents before allowing conflicting operations. Cleanup never removes unrelated paths.

One writer service per library, serialized commit queue, optimistic revision checks, and consistent reader snapshots. Heavy IO runs outside the write queue. Start with local disks and directly attached storage; live concurrent network/cloud folder editing requires its own supported locking/storage design. Backups use SQLite's backup API plus a manifest and retained media, rather than copying a live database file opportunistically.

## Command contract and UI consistency

Commands carry `protocolVersion`, `requestId`, `libraryId`, relevant project/asset/job IDs, and expected revision for mutations. Persist idempotency results for retried mutating requests. The response contains a committed revision and changed entity IDs, or a typed error with no successful-looking UI state. Publish revisioned events only after commit. Reconnecting clients obtain a snapshot and resume events from its revision; gaps require resynchronization.

Initial command families:

- Library: create/open/close/list-recent/backup/consolidate.
- Organization: create/rename event, create/duplicate/open project.
- Import: plan/start/cancel/status; probe capabilities before promising preview/export support.
- Media: inspect usages/relink/remove entry/plan removal/commit removal.
- Project: apply edit/undo/redo/read revision.
- Output: plan export/start/cancel/status/reveal output/package library.

Deletion plans are bound to a catalog revision and expire on conflicting edits. Never let a stale preview authorize newly created placements. Native paths enter through trusted host selection and resolution; renderer commands use IDs or scoped handles. Relative managed paths must resolve within the selected storage root, including symlink checks. Return codes such as `revision-conflict`, `media-offline`, `media-in-use`, `unsupported-codec`, `insufficient-space`, and `destination-unavailable` with structured context.

UI drag previews can remain responsive, but commit/rollback uses the service's result. Switching libraries or projects invalidates old view subscriptions and pending UI completions; jobs retain their original library/project identity. HTML bindings are compatibility metadata, never required identity for a native timeline clip.

## Import lifecycle

`queued -> inspecting -> copying/linking -> verifying -> committing -> completed`

Cancellation and failure are explicit terminal states; interrupted operations enter recovery on restart. Batch imports retain per-item outcomes and allow retries without duplicating committed assets.

1. Choose target library/event and managed or linked storage policy. All entry paths (picker, drag/drop, Finder/open-with, paste-generated media) call the same import service.
2. Inspect real streams and decoder capabilities, file access, required space, and media validity. Keep container/codec/HDR/alpha/audio properties separate. Preserve a supported original even when a playback derivative is needed. Report unsupported streams without creating a misleading ready clip.
3. Managed imports copy/clone into staging using bounded IO, never a whole-file renderer buffer. Detect source changes during import and retry/fail. Use exclusive unique storage locations; display filenames can collide safely.
4. Linked imports record durable OS locator/bookmark information where available, plus identity checks. Missing volumes produce offline state without deleting edits. Relinking validates source identity/stream compatibility; intentional replacement creates a new version.
5. Verify and publish the asset atomically at catalog level. Schedule proxies, thumbnails, and waveforms as independent retryable jobs. Proxy failure must not invalidate a valid original.
6. Adding imported media to a timeline is a separate explicit editing command. The browser import result alone does not create hidden timeline placements.

Size is constrained by available storage and decoder/platform capabilities, not an arbitrary desktop HTTP upload body limit. A bounded HTTP upload route may remain for synthetic browser test inputs, but is not the desktop import transport. Filename equality is never a duplicate check. Hashing can be streamed; physical deduplication requires confirmed content equality and reference accounting, not an early partial fingerprint.

## Removal and retention

Separate removing a timeline placement, removing an event entry, removing an asset from the library, and purging managed bytes. Removing a project does not remove assets used by another project. Removing a linked asset never deletes the external original.

Usage queries include every project, compatibility resources, retained undo/history, and active export/package jobs. Ordinary removal cannot silently cascade through projects. An explicit remove-placements operation displays scope, checks the expected revision, and commits affected projects/catalog/history together. Retain managed bytes for undo and running jobs; collect only after all retention references expire. Unresolved HTML/CSS/script dependencies block destructive removal with actionable locations.

## Output lifecycle

There are three different outputs: rendered media, a portable library/project package, and an interchange document. Rendered output is not a saved editing project. Interchange adapters report unsupported constructs explicitly; FCPXML support would be a separate feature, not automatic compatibility with Final Cut library bundles.

`queued -> snapshotting -> rendering -> validating -> publishing -> completed`

Persist jobs before execution. Capture one immutable project revision, all assets/resource versions, render settings, native engine version, and relevant effect dependencies. Pin these until completion/cancellation recovery. Managed originals are immutable. For externally mutable linked sources, use independent snapshot copies or verified filesystem clones before rendering; a hard link does not freeze content. If snapshotting cannot finish consistently, fail visibly instead of rendering changing input.

Preflight original availability, codecs, range, resolution, frame rate, color transfer/primaries/matrix/range, alpha, audio layout, destination access, and space estimates. Proxy-only export must be an explicit quality choice. Use the existing direct/native/compatibility render paths according to actual capability, with equivalent timing and output requirements.

Render to a unique temporary output on the destination filesystem. Validate final container, streams, duration, and expected dimensions/audio, then atomically publish with no-clobber semantics. Overwrite requires explicit intent and recoverable replacement. A published output is the condition for completion; 100% encoding progress alone is not completion. Persist enough publication intent to reconcile a crash between publication and the final catalog update.

A cancelled job never presents a partial output as final. On restart mark interrupted jobs recoverable; resume only stages that explicitly support safe resumption, otherwise restart from the pinned snapshot. Background jobs must not depend on UI heartbeat for their data lifetime.

Portable packaging captures a consistent revision/dependency manifest, includes managed copies of required linked originals when requested, preserves licenses/availability limitations for external resources, and verifies reopening. Metadata-only backups explicitly report that external source media is not included.

## Migration and implementation gates

1. Introduce versioned native library contracts, catalog/recovery service, and tests without changing legacy storage. Package/load the service in the actual Electron build.
2. Deliver a complete new-library slice: create/open library, create two projects, import shared media, edit/save/reopen both. Add library/event navigation within the existing browser; preserve existing editor styling and controls.
3. Move imports, usage planning, undo retention, and background derivatives behind the shared asset catalog. Test every import entry path and mixed media, not selected filenames.
4. Integrate revision-pinned exports and persistent job recovery; verify outputs against the current preview and native timing contracts.
5. Provide copy-based migration: inventory the old project, copy it to a new library staging area, preserve all HTML/assets/effects/unknown authored resources, create stable ID mappings, validate dependency counts and timing, then publish the new bundle. Keep the original unchanged. Interrupted migration leaves the original openable and a resumable/discardable new staging area.
6. Validate migrated projects in packaged macOS builds before making libraries the default desktop startup route. Never mark migration successful merely because JSON parses.

Acceptance matrix: two projects sharing one asset; duplicate filenames and Unicode; video/audio/stills/HTML resources; mixed frame rates and VFR; large imports with bounded memory; source modification and removal mid-import; low disk and read-only targets; cancellation/crash at every publish boundary; offline/relinked external drives; undo after removal and app restart; concurrent import/edit/export; stale UI requests; project switches during jobs; export while source is edited/removed; moving and reopening a managed library; portable-package verification; old-project preservation. Compare actual exported frames/audio and reopened editing state, not only mocked API responses.

## References and limits

The organizational precedent is Apple's description of libraries containing events/projects and supporting managed/external media: https://support.apple.com/en-au/guide/final-cut-pro/verfdd5c590e/mac . This design does not claim to reproduce Apple's private implementation.

SQLite provides database atomic commit (https://www.sqlite.org/atomiccommit.html) and a live database backup API (https://www.sqlite.org/backup.html). Those guarantees do not automatically cover external media files; the recovery protocol above is an application responsibility.

The 0.0.6 implementation provides the native catalog, library/event/project UI, managed and linked import, project-compatible media views, and snapshot-based export. Full migration, catalog revision history, retention cleanup, backup/package tooling, and import job controls remain target work. See `library-implementation-status.md` rather than treating every requirement above as already shipped.
