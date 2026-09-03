# MpVFX Privacy Notice

Effective: September 3, 2026

MpVFX is a local desktop video editor. The official source configuration does not include an
analytics account, analytics key, or feedback-booking URL, so analytics and in-product feedback
submission are disabled by default.

## Data stored locally

MpVFX stores projects, imported media, edits, thumbnails, waveforms, transcoding caches, renders,
recovery records, and application preferences on the user's device. These files are not uploaded by
the default application merely because a project is opened or edited.

## Network access

MpVFX may access the network when a user requests a feature that needs remote content:

- Background removal downloads the checksum-pinned model documented in
  [docs/REMOTE_ASSETS.md](docs/REMOTE_ASSETS.md) from a GitHub release on first use.
- Online fonts are retrieved from Google Fonts when selected.
- User-supplied remote media URLs are loaded from the host chosen by the user.
- A custom distributor can configure its own PostHog-compatible analytics host and key at build
  time. Such a build must provide its own privacy notice and consent controls.

The application does not intentionally send project media, filenames, captions, or rendered video
to an analytics service. Custom builds and third-party destinations have their own policies.

## User control

Users can delete projects, renders, and caches from their local application-data directory. Any
custom analytics-enabled build must honor browser Do Not Track and the local opt-out setting
`mpvfx:telemetryDisabled=1`.

## Developer conversation privacy

AI-agent conversation histories, prompts, responses, and session data are private developer data,
not MpVFX source. Common agent-state directories and conversation-export filenames are excluded by
the repository ignore rules, and the release-readiness check rejects likely transcript files. The
tracked `studio/AGENTS.md` file contains maintenance instructions only; it is not a conversation
history.

Privacy or security concerns should be reported through the private process in
[SECURITY.md](SECURITY.md).
