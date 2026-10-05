# Teammate integration review — 2026-10-03

## Preserved state

- Original advanced checkout: `/Users/ash/Documents/Becoming-A-deciplined-dev/mpvfx-vkf`, branch `codex/editor-consistency-repair`, commit `d8f92c9` plus uncommitted changes.
- Local snapshot of that source state: `8671fb1`. All 1,463 source files matched byte for byte at verification time.
- Integration branch: `codex/integrate-teammate-components` in the current worktree.
- Fetched GitHub main: `07e2194a3da468808c40da11ab42e93594c3f895`.
- Merge is pending locally. No push or PR has occurred. Existing teammate commits and authorship are included through the merge's GitHub parent.

## Verification

- Runtime: Node 24.19.0 from the bundled workspace dependencies.
- Full build passed, including both C++ modules, renderer, frame runtime, and Electron main/preload. The bundled runtime required official Node 24.19.0 headers and `NODE_API_INCLUDE_DIR` for native compilation.
- Architecture boundaries passed.
- Focused integration tests: 41 passed in 8 files.
- Full suite: 6,598 passed, 47 failed, plus two suites unable to collect due to missing fixtures and 13 unhandled errors.
- Every one of the 47 failing test names also failed against the preserved pre-merge snapshot under Node 24. This proves the failures predate the teammate merge; it does not prove the behaviors are correct.
- Separate library export test and desktop IPC/resource tests passed with filesystem polling (1 + 4 tests). Polling avoids the macOS filesystem watcher exhaustion observed in the broad run.
- Two fixture suites refer to missing local fixture HTML and have not been recreated.
- Tests of publishing validate editor handoff and local file boundaries without contacting publishing services. Python syntax was validated; account authorization, actual GUI startup, and uploads remain unverified.

## Review policy

Do not reinstate removed features, CI jobs, build targets, integer-only source-time restrictions, old DOM fallbacks, or canvas movement constraints merely to satisfy old tests. Review expected product behavior with the user first. Some tests need replacement; others may identify existing bugs. Preserve the current native source-time, identity, library, and export architecture while investigating.

The imported review dialog's decorative shadow was removed to conform to existing editor style rules. The pre-existing fill selection ring remains unchanged. The practice background override was excluded from release behavior while its author commit remains in the merge history.

## Confirmed product decisions

The user confirmed the following on 2026-10-03:

- Keep the CI unit-test job removed.
- Keep the Intel macOS installer target removed.
- Allow clips to be dragged and resized beyond the canvas.
- Keep the old flat inspector footer recording control removed.

Only test expectations were changed for these decisions; production behavior and workflow files were not changed. Canvas tests retain snapping, crop-overlay alignment, cancellation, and release checks. The inspector coverage test now checks the existing Transform section telemetry and verifies that supplying a recording callback does not bring back the retired footer control.

The three affected test files pass under Node 24.19.0: 36 tests passed. This resolves eight previously failing cases. A full suite rerun has not been performed after these updates; 39 of the previously recorded failing cases remain to review, along with the fixture collection and unhandled errors.

The user subsequently directed us to retain the latest local behavior for the remaining three decisions:

- Keep exact fractional source positions for trims and splits at modified playback rates.
- Keep sparse authored track numbers stable.
- Treat `?` and `#` as literal characters in imported filesystem names.

Five older test cases were updated to preserve these contracts. No production code was changed for these decisions. Tests now check fractional source position round-tripping and repeated trims without drift, unchanged input documents, exact compatibility timing, stable lane-change destinations, and special-character filenames across import surfaces.

The five affected files pass under Node 24.19.0: 81 tests passed. Together with the earlier eight cases, 13 of the original 47 failures are resolved. The remaining 34 cases still require review; this count is based on the original failure inventory, not a new full-suite run.

## Failure inventory from the full Node 24 run

- src/features/canvas/tests/compositionReliabilityFixture.integration.test.ts [ src/features/canvas/tests/compositionReliabilityFixture.integration.test.ts ]
- src/features/canvas/tests/persistSeam.integration.test.ts [ src/features/canvas/tests/persistSeam.integration.test.ts ]
- desktop/tests/appLifecycle.test.ts > desktop application lifecycle > cancels startup without leaking a late runtime or opening a window
- desktop/tests/githubWorkflows.test.ts > GitHub Actions readiness > keeps tests and source compilation in a dedicated non-publishing workflow
- desktop/tests/githubWorkflows.test.ts > GitHub Actions readiness > builds native installers on matching macOS, Windows, and Linux hosts
- shared/project/nativeProjectClipCommands.test.ts > native project clip trim, split, and delete commands > rejects trim and split boundaries that cannot map to an integer source frame
- shared/project/nativeTimelineDeletePlan.test.ts > native timeline delete planner > rejects a selected source that disagrees with the durable binding
- shared/project/nativeTimelineRangeEditPlan.test.ts > native timeline range edit planner > rejects a trim boundary that cannot map to an integral source frame
- runtime/export/tests/nativeProject.test.ts > native project render body script > uses strict scoped bindings in export, without treating canonical clip ids as DOM ids
- runtime/export/tests/nativeProject.test.ts > native export integration > materializes native mute into the offline mixer contract without hiding video
- shared/media/tests/mediaImportPolicy.formats.test.ts > media import format catalog > classifies cache-busted and fragment-bearing asset URLs
- src/features/media/mediaImportSurfaces.test.ts > media import surface parity > uses the same classification for uppercase and URL-suffixed media
- src/features/project/nativeProjectRuntime.test.ts > installNativeProjectRuntime > projects optional clip playback rate into preview transport metadata without rounding it
- src/features/project/nativeProjectRuntime.test.ts > installNativeProjectRuntime > calculates project duration from the latest clip end and removes only its own player
- src/features/project/nativeTimelineDeleteTransaction.test.ts > native timeline delete transaction > uses one durable file transaction for every snapshot before publication
- src/features/project/nativeTimelineDeleteTransaction.test.ts > native timeline delete transaction > deletes clips across sorted source files with one revision and one history entry
- src/features/project/nativeTimelineDeleteTransaction.test.ts > native timeline delete transaction > rejects when the callback fails to match any one exact target
- src/features/project/nativeTimelineDeleteTransaction.test.ts > native timeline delete transaction > rolls successful writes back in reverse order when a later file write fails
- src/features/project/nativeTimelineDeleteTransaction.test.ts > native timeline delete transaction > rolls every file back when history registration fails
- src/features/project/nativeTimelineDeleteTransaction.test.ts > native timeline delete transaction > rolls back if cancellation arrives between durable writes
- src/features/project/nativeTimelineSources.test.ts > video, mirrored=true, omitted row source > persists split atomically
- src/features/project/nativeTimelineSources.test.ts > audio, mirrored=true, omitted row source > persists split atomically
- src/features/project/nativeTimelineSources.test.ts > image, mirrored=true, omitted row source > persists split atomically
- src/features/project/nativeTimelineSources.test.ts > video, mirrored=true, omitted row source > persists delete atomically
- src/features/project/nativeTimelineSources.test.ts > audio, mirrored=true, omitted row source > persists delete atomically
- src/features/project/nativeTimelineSources.test.ts > image, mirrored=true, omitted row source > persists delete atomically
- src/features/project/useNativeProjectSession.test.tsx > installs at the restored editor playhead when native data arrives after URL hydration
- src/features/inspector/propertyPanelInputCoverage.test.tsx > flat PropertyPanel input coverage > emits only named flat events from known sections for every visible layout input
- src/features/inspector/propertyPanelResetCoverage.test.ts > property-panel reset coverage > requires every shared slider caller to declare its reset behavior
- src/styles/tests/noDecorativeShadowsOrGradients.test.ts > flat Studio chrome > contains no decorative shadows or gradients
- src/features/canvas/tests/inlineTextStyleRange.test.ts > applyInlineStyle when something else is painting the glyphs > mirrors the colour into the fill when an ancestor is overpainting
- src/features/canvas/tests/inlineTextStyleRange.test.ts > applyInlineStyle when something else is painting the glyphs > mirrors only the run whose own ancestor path is overpainting
- src/features/canvas/tests/inlineTextStyleRange.test.ts > applyInlineStyle when something else is painting the glyphs > drops a generated mirror when the ancestor stops overpainting
- src/features/canvas/tests/useDomEditOverlayMediaContainment.test.ts > media gesture canvas containment > prevents a video from crossing the canvas edge even when snapping is off and Alt is held
- src/features/canvas/tests/useDomEditOverlayMediaContainment.test.ts > media gesture canvas containment > treats the cropped visible edge as the media boundary
- src/features/canvas/tests/useDomEditOverlayMediaContainment.test.ts > media gesture canvas containment > keeps the imperative drag border aligned with a left-cropped clip's handles
- src/features/canvas/tests/useDomEditOverlayMediaContainment.test.ts > media gesture canvas containment > keeps cropped chrome stable when a moved drag is committed
- src/features/canvas/tests/useDomEditOverlayMediaContainment.test.ts > media gesture canvas containment > caps a video resize at the canvas boundary before the draft is committed
- src/features/timeline/tests/useTimelineAssetDropOps.mediaImport.test.tsx > timeline OS-media import > extends the composition when imported media lands beyond its current end
- src/features/timeline/tests/useTimelineAssetDropOps.mediaImport.test.tsx > timeline OS-media import > sequences mixed image and audio imports and extends through the final clip
- src/features/timeline/tests/useTimelineAssetDropOps.native.test.tsx > native timeline asset drop integration > commits one library drop as one exact native and compatibility transaction
- src/features/timeline/tests/useTimelineAssetDropOps.native.test.tsx > native timeline asset drop integration > batches an OS multi-file drop into one revision and one durable history entry
- src/features/timeline/tests/useTimelineEditing.test.tsx > useTimelineEditing native-canonical media insertion seam > forwards the native document and durable commit dependency to the asset-drop handler
- src/features/timeline/tests/useTimelineEditing.test.tsx > useTimelineEditing native-canonical range edits > routes trim-in through one native plus HTML transaction with exact playback-rate source math
- src/features/timeline/tests/useTimelineEditing.test.tsx > useTimelineEditing native-canonical range edits > routes trim-out without changing the native source-in frame
- src/features/timeline/tests/useTimelineEditing.test.tsx > useTimelineEditing native-canonical range edits > restores the exact live range and duration when native trim history fails
- src/features/timeline/tests/useTimelineEditing.test.tsx > useTimelineEditing native-canonical range edits > rebases a trim once onto a newer persisted native revision
- src/features/timeline/tests/useTimelineEditing.test.tsx > useTimelineEditing native-canonical group range edits > commits every selected trim in one native revision and one HTML history transaction
- src/player/components/tests/timelineTrackPersistPipeline.test.ts > track persist pipeline (manifest → factory → lanes → drag commit) > a lane change on a sparse file persists the AUTHORED target track, not the display lane
