# Privacy

MpVFX keeps projects, imported media, edits, thumbnails, caches, and renders on the user's device.
The default build does not contain an analytics key or analytics destination.

Network access occurs only for features that require remote content, including loading an online
font or opening a media URL supplied by the user.

MpVFX does not intentionally send project media, filenames, captions, or rendered video to an
analytics service.

The desktop application records a bounded diagnostic timeline on the device: editor control
actions, errors, export progress, helper-process results, performance, and operating-system
and GPU information. It does not record typed input, clipboard contents, project media, or
command arguments. Known credentials, email addresses, and local paths are redacted before
writing diagnostic events. Logs rotate and expire automatically.

Native crash memory dumps stay on the device. They may contain fragments of process memory
and are excluded from the standard diagnostic report. Crash reporting never uploads them.

**Diagnostics → Save report** creates a compressed report only when requested. The app does
not automatically transmit local diagnostics. Review a saved report before sharing it.
