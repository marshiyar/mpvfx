# Stack Exchange video QA research corpus

This directory is deliberately separate from MpVFX application source. It contains 593 Stack
Overflow questions and the answers captured with them, used to trace real-world video engineering
concerns to independently written MpVFX behavior tests.

## Contents

- `data/video-qa.jsonl` — copied question and answer text
- `sources.jsonl` — one attribution record for every retained question and answer
- `manual-sources.json` — disclosed fallback metadata for a retained post unavailable from the API
- `LICENSE.md` — license scope and version information

Every manifest record includes the post author, direct source URL, original contribution date,
applicable Creative Commons license and link, and a description of the dataset transformation.
Stack Overflow and individual contributors do not endorse MpVFX.

The answer text is source material, not accepted product truth. Executable tests are maintained in
`studio/tests/qa/` and validate MpVFX's own behavior contracts.

After changing corpus membership, regenerate and validate attribution:

```bash
node scripts/update-stackexchange-attribution.mjs
cd studio
npm run release:check
```

The update script reads metadata from the official Stack Exchange API. One retained 2026 question
was unavailable from the API when the manifest was generated; its author, title, URL, and time were
preserved from Stack Overflow's search listing in `manual-sources.json`, with that limitation stated
in the record. Review changes before committing because display names, links, and post licenses can
change with post revisions.
