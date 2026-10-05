# Library workflow delivered in 0.0.6

This records the implemented increment, separate from the complete target architecture in `library-import-export-architecture.md`.

## Available in the application

- Create a user-located `.mpvfxlibrary` directory and reopen libraries from the sidebar. Recent library paths persist in app settings; an unavailable library remains in the recent-path registry for a later restart.
- Create events and projects. New projects immediately contain a validated native timeline document, HTML compatibility view, and required local resources.
- Import with managed copying by default. Library import also offers linked originals and fingerprint-verified relinking. The existing media picker and file drops route library-project imports into the same catalog. Synthetic clipboard files use the bounded upload adapter and then the same library import path.
- Attach one library asset to multiple projects. Each project can independently edit/remove its placement without removing the library original or another project's media.
- Preserve the existing editor, timeline, inspector, effects, media browser, and standalone project entry. Project switches drain pending field/DOM saves and remount project-scoped UI state.
- Export library projects using retained snapshots. Project files and media are copied/cloned under the project's access lock; subsequent edits cannot change those copies. Export settings and a native document hash are retained with the snapshot.
- Keep library export jobs alive when switching projects. Completed/failed/interrupted results persist in the catalog and appear under Library exports. Save As publishes a separate output without overwriting an existing destination.
- Reopen a moved managed library using its internal relative project/media/output paths.

## Ownership and compatibility

`native/library/library_node.cpp` owns the SQLite schema and catalog commands. Node-API executes database operations on worker threads. The module uses macOS system SQLite; it does not link to a developer-local SQLite installation. A native advisory lock prevents two processes from writing the same library concurrently and is released by the OS after process exit.

`runtime/library/libraryService.ts` coordinates host filesystem operations, codec validation, native catalog calls, and export retention. It is exported through the public runtime entry. Electron owns the native file dialogs; the renderer sends commands and receives library views through the restricted preload bridge.

The reusable keyframe engine remains a separate native target. No WebAssembly engine was introduced.

In this increment, a project's existing `.studio/project.json` and its authored compatibility resources remain authoritative for editing. The catalog is authoritative for library/event/project identity, assets, project media attachments, and export records. Project revisions are not independently editable in the catalog. Moving revision storage fully into the catalog is a later migration, not an additional current state owner.

Project media views are independent filesystem copies, using copy-on-write clones when supported. This preserves the existing project-relative playback/export contracts and prevents editing a project view from modifying the library original. Linked mode preserves the external original; attaching it also makes a project editing copy. On filesystems without clone support, these copies consume additional storage. Filename equality does not deduplicate assets.

Imports use exclusive staging/publish operations and incremental hashing. Pending managed imports with a valid staged original recover on reopen. Pending/incomplete entries are not offered as ready timeline media. Database and filesystem operations are coordinated explicitly; SQLite does not make a media copy part of its transaction.

## Verification

- 119 focused tests passed in the final regression selection (115 in the main run, four in the isolated desktop runtime run).
- The selection covers the real C++/SQLite service, a 501 MiB library import, two projects sharing media, Unicode/name collisions, linked/offline/relinked sources, moved libraries, process locking, staged import recovery, interrupted jobs, snapshot isolation, no-overwrite output copying, native timeline commands, existing media deletion/undo, import routes, and persistent export teardown.
- Real FFmpeg exports from two projects were checked for duration, dimensions, video pixels, and audio streams while the live project/media files were modified after snapshot creation.
- The packaged Electron app was exercised with a temporary profile and generated video: create library using the sidebar, import video, add it to two project timelines, persist native documents, export while switching projects, save output, quit, and reopen. The native file-picker answers were automated; the actual application/catalog/import/edit/export implementations ran.
- Production build includes shared/renderer/desktop typechecking, both C++ native targets, renderer build, desktop compilation, and packaging checks. Architecture boundary checks passed.
- A broader exploratory run found two existing GitHub workflow text-assertion failures in `desktop/tests/githubWorkflows.test.ts`; no workflow or publishing configuration was changed. This is not a claim that the entire repository test suite passes.

Packaged test fixtures and screenshots are stored under the temporary profile printed by `studio/tests/e2e/library-workflow.mjs`. This test script is excluded from the distributed app. The user's original project is not a test fixture and was not modified.

## Limits of this increment

The full target architecture also includes copy-based migration of existing projects, consolidation/portable archive creation, metadata backup/restore UI, catalog-wide deletion/garbage collection, cancellable persisted import jobs with retry UI, revision history stored in the catalog, and interchange adapters. Those are not implemented by this increment. Existing projects stay on the legacy path until an explicit migration feature is delivered.

Export snapshots and originals are retained; automatic retention cleanup is not implemented. Interrupted exports are recorded, not automatically resumed. Import progress/cancellation is not yet exposed. Library export history retains original jobs; Save As is an additional file copy and does not rewrite the stored original output location. Finder package registration/double-click opening is not implemented; use the in-app Open control.

Only the macOS arm64 installer was built and exercised. This local build is not Developer ID signed or notarized. Its default project frame rate/canvas is 30 fps at 1920×1080, using existing editor controls thereafter.

## Final artifact

- Installer: `studio/out/make/MpVFX-0.0.6-arm64.dmg`.
- SHA-256: `e1509a656e4b8c31ad2dfa80fdd914a0ba78f647e384fad734f0b6656214d980`.
- `hdiutil verify` reported the image checksum VALID.
- The bundled `mpvfx_library.node` links only macOS system libraries and declares a macOS 15.0 minimum deployment target. It was exercised on the development Mac; this is not a claim of testing every supported OS release.
- Final packaged workflow evidence: `evidence/library-0.0.6.json` and `evidence/library-0.0.6.png` (generated red test video, not user media).
- Repeat the packaged test from `studio/` with `node tests/e2e/library-workflow.mjs` after building the app. The test creates its own temporary profile/library and does not install the app or edit user projects.
