# Silent-video export repair — 0.0.7

The reported three-video project failed in the full composition producer with two audio type mismatches. Native FFprobe confirmed that one video had AAC audio and the other two had no audio stream. Timeline insertion had unconditionally written `data-has-audio="true"` for every video. The producer created two nonexistent audio sources from those hints and rejected the composition.

The same project, copied to an isolated Electron profile, reproduced that exact failure in the previous packaged app. The repaired packaged app exported all 594 frames at 1920×1080, 30 fps, with a duration of 19.8 seconds. Output waveform measurements at seconds 1 and 6 were approximately −15.6 and −16.2 dBFS; the two silent clips measured digital silence at seconds 11 and 16. Representative frames from all three clips were extracted and visually inspected. The source HTML and native document hashes were unchanged. These checks establish the reported audio fix; they are not a full pixel-by-pixel or color-management certification.

Implementation:

- `runtime/media/metadata.ts` reads stream capabilities with the bundled native FFprobe. It enforces project boundaries, rejects symlink escapes, supports cancellation, bounds process time/output, and detects source changes during probing.
- The dedicated `/media/streams` route supplies those facts to new timeline insertions. The existing `/media/metadata` route used by color grading retains its original contract. Unknown probe results remain unknown rather than being labeled silent or audible.
- Before full composition export, reachable composition sources are checked against actual video streams. Only the disposable export view receives corrections. Genuine audio and explicit mute settings are preserved. Explicit audio elements retain strict producer validation.
- Nested compositions, source children, Unicode/escaped paths, and repeated references are handled. Unique media are probed once per export preparation. No filename or container-specific exception is used.

Verification:

- 319 tests passed across 24 selected suites covering export routing, native export materialization, direct media rendering, library snapshots, and timeline insertion. The new native media checks include silent/audible MP4, MOV, M4V, and WebM, explicit mute, missing/corrupt input, path boundaries, nested compositions, and cancellation.
- The packaged library workflow was exercised separately with newly imported silent and audible videos: create library, import, add to both projects, verify persisted audio capability, export, switch project, save output, quit and reopen.
- Type checking, architecture boundaries, and `git diff --check` passed. Two older media-import tests expecting unoccupied track numbers fail equally on the unchanged HEAD implementation; they are unrelated to stream detection and were not changed to mask their failures. This is not a claim that every repository test passes.
- Installer: `out/make/MpVFX-0.0.7-arm64.dmg`, validated by `hdiutil verify`. SHA-256: `07248001e56fc956bd50e4d722888bf65dd4cd0faad9f1ee93eb49f4e2382320`.
- Actual-project evidence: `design/evidence/export-audio-0.0.7.json`. Retained output and extracted frames: `out/verification/0.0.7/`.

The existing library/project need no migration or reimport. Historical failed jobs remain failed history entries; a new export uses the corrected preparation. Work remains local on `library-import-export` with no push or PR.
