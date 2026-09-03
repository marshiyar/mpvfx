# Data provenance

## Stack Overflow QA corpus

The repository contains a 593-question research corpus used to trace real-world video engineering
concerns to MpVFX behavior contracts. It is not product content and is not bundled into desktop
installers.

The source text is stored in
`third_party/stackexchange-video-qa/data/video-qa.jsonl`. Attribution metadata for every retained
question and answer is stored in `third_party/stackexchange-video-qa/sources.jsonl`.

The corpus is licensed per post under the Creative Commons Attribution-ShareAlike version recorded
in the manifest. MpVFX tests are independently authored unless a file explicitly says otherwise.
Facts, engineering ideas, identifiers, and behavior requirements are separated from copied prose;
copied post text remains inside the separately licensed corpus. Trace maps contain only source IDs,
line numbers, and independently authored MpVFX behavior-contract identifiers.

Run the following after changing corpus membership:

```bash
node scripts/update-stackexchange-attribution.mjs
cd studio
npm run release:check
```

The update command queries Stack Exchange's official API and requires network access.

## Test media

Personal video, audio, thumbnails, captions, LUTs, and raster media are denied by default in the
repository ignore rules. The sole publishable media fixture is
`studio/tests/e2e/fixtures/design-panel-qa/assets/test.mp4`, a generated two-second test pattern and
tone. Its SHA-256 checksum is enforced by the release-readiness check, so personal footage cannot
silently replace it under the allowlisted path. Its provenance is recorded beside the test fixtures.
