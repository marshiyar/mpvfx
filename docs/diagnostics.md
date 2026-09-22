# Local desktop diagnostics

MpVFX's desktop application records the same diagnostic schema on macOS, Windows,
and Linux. Recording starts in the main process before the editor window and the
render engine are loaded. It does not require an analytics account or a network
connection. This feature never uploads reports. Existing optional analytics and
their opt-out policy remain separate.

## Getting a report

1. Reproduce the problem in a build containing this feature.
2. Open **Diagnostics · recording locally** at the bottom of the media sidebar.
3. Choose **Save diagnostic report**. Attach the resulting
   `MpVFX-diagnostics-*.json.gz` file when reporting the problem.

The React error screen also has this control. If the editor process crashes,
Electron's native recovery dialog offers to save a report and reload the editor.
After a complete app crash, reopen MpVFX and save a report; the retained previous
session is included. A download made before a problem will not contain later
events.

The control reports when writing is unavailable. Reports are compressed JSON;
standard gzip tools can decompress them. The `schemaVersion` is currently `1`.

## What is recorded

| Evidence | Details |
| --- | --- |
| Build and machine | App version, fingerprint of desktop code, renderer entry and available dependency lock, Electron/Chromium/Node versions, OS release, architecture, CPU model/core count, RAM, GPU devices/drivers and acceleration status |
| Interactions | Click target's structural location, explicit action names, position/button/modifiers, pointer down/up/cancel with duration and distance, control changes, edit/navigation shortcuts outside editable fields |
| App commands and decisions | Existing semantic telemetry plus reload, selection, drag, resize and commit trace channels; frequent movement traces are sampled |
| Renderer failures | JavaScript errors, unhandled promise rejections, React error boundaries, resource failures, preview frame errors and warning/error console messages |
| Export | Job ID, format/FPS/quality/dimensions, renderer selection, direct-export fallback, stage/progress, cancellation, completion/failure, elapsed time and time without progress |
| Helper processes | Executable basename, PID, job/request correlation, observed `windowsHide`/`detached`/shell settings, exit code/signal/duration, bounded stderr tail and live error samples; sync probes and promisified helpers are supported |
| Main process and native crashes | Fatal JavaScript exceptions without changing Node's termination behavior, Electron renderer/child process exits including reason, startup failures, unresponsive/responsive windows, local Crashpad minidumps, previous unclean-session marker |
| Performance | Main/renderer heartbeats every 10 seconds, memory, CPU, available disk space where supported, event-loop delays, browser long tasks and per-Electron-process metrics |
| Local API | Failed, slow and modifying requests, sanitized operation route, status, duration and request ID; no request/response bodies |

Native dumps cover Electron processes. External FFmpeg/Chromium helpers are
observed through their lifecycle and stderr; their native memory dumps are not
promised by Electron's crash reporter.

## Reading evidence accurately

Each event has the server's `sessionId`, sequence `seq`, UTC `time`, monotonic
`elapsedMs`, event name, severity, context and redacted data. Export-related work
carries `context.jobId`; requests carry `context.requestId`. Renderer events are
prefixed `client.` and retain a renderer ID, client sequence and client time in
addition to server receipt time. The server does not accept client-supplied
session IDs, authoritative timestamps or native-crash assertions.

Use sequence and monotonic elapsed time within a session. A wall-clock change
must not reverse the order of that session's events. Separate sessions are
grouped in the report. Build and system metadata are repeated in rotated files
and included in the report's `sessions` mapping, so rotating away the initial
startup event does not lose build identity.

`session.previous_unclean_exit` means the previous process did not finish normal
shutdown. It can result from a crash, forced termination, power loss or an
interrupted marker write; it does **not** independently prove a crash.
`electron.render_process_gone` records Electron's actual reason and exit code.
An export heartbeat's `noProgressForMs` describes observed progress, not a claim
that a lengthy render stage is deadlocked.

For the reported Windows terminal problem, follow `export.requested` →
`export.renderer_selected` → `process.start` → `process.stderr`/`process.exit` →
`export.progress`/`export.finished` for one job ID. Check the actual Chromium
launch options and GPU errors alongside the last stage and heartbeat.

## Privacy and storage limits

The collectors omit typed text, clipboard data, input values, DOM text/labels,
screenshots, media contents, request/response bodies, environment variables and
command arguments. Structured sensitive fields and recognized credentials,
email addresses, local paths, URLs and media filenames are redacted before disk
writes. These rules are regression-tested with fake credential canaries. No
collector reads signing credentials or the Keychain. As with any error log,
arbitrary third-party messages cannot be guaranteed to contain no identifying
information; review reports before sharing them publicly.

Native minidumps can contain process memory and cannot be reliably redacted.
They stay in `diagnostics/native-crashes` and are **never included** in the normal
report. Only dump inventory counts/sizes are logged. Crashpad uploads are disabled.
Electron documents this local-only mode in its
[crash reporter API](https://www.electronjs.org/docs/latest/api/crash-reporter).

Logs rotate at approximately 2 MiB per file, with at most 12 files and seven days
of history. Native dumps are pruned separately to seven days/100 MiB, except
dumps less than a minute old that Crashpad may still be writing. Retention runs
while the app is running or on the next launch. Source directories and Git are
not log destinations; generated JSONL logs, dumps and report archives are ignored.

Normal disk batches flush every 500 ms. Fatal exception/native crash events force
a synchronous flush. Renderer delivery also batches every 500 ms. A sudden
process kill or power loss can lose the final buffered events. Queues, text size,
depth and event rates are bounded so a flood cannot exhaust storage or memory;
loss counters, invalid-line counts and rotation metadata expose those limits.
Fatal crash events bypass normal event throttling. Logging is diagnostic
evidence, not a promise that every possible failure or interaction survives.

Default locations are based on Electron's per-user data directory:

| Platform | Logs |
| --- | --- |
| macOS | `~/Library/Application Support/MpVFX/diagnostics` |
| Windows | `%APPDATA%\MpVFX\diagnostics` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/MpVFX/diagnostics` |

`MPVFX_USER_DATA_DIR` overrides the root for isolated development and testing.

## Verification

```sh
cd studio
npm run test:diagnostics
npm run typecheck
npm run desktop:build
npm run test:diagnostics-native
```

The native test launches a separate Electron instance with temporary data. It
renders a generated two-cut video and verifies output pixels and job-correlated
Chromium/FFmpeg logs, clicks the real report control, checks an actual downloaded
archive and redaction on disk, deliberately crashes that test renderer, checks a
native minidump, and relaunches to verify retained evidence. It does not attach to
an existing editor. Its temporary project is removed on completion. Generated
results are under `studio/out/diagnostics-verification`.

`.github/workflows/diagnostics.yml` runs the focused and native checks on macOS,
Windows and Linux (Xvfb). The Linux test uses `--no-sandbox` only for its isolated
CI Electron process; production window sandbox settings are unchanged. A local
macOS pass does not establish Windows/Linux runtime success. Those native jobs
must pass before calling those platforms verified. That workflow tests development
Electron. The release workflow runs the same native checks with `--packaged` after
building each installer, using the actual bundled executable and dependencies.
Publication waits for all four platform/architecture jobs. Run it locally after
`npm run desktop:make` with `npm run test:diagnostics-native -- --packaged`.
