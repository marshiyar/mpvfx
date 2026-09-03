# Working on Studio

Read this before your first change in `studio`. It is the handful of
things that are not visible from the source, and that cost real time to
rediscover.

## Product boundary

Studio is a media-first nonlinear video editor. Import, timeline editing, preview, audio, captions,
graphics, and export are the primary product. Core workflows must work through the UI without an
agent prompt or source editing. Use projects, media, tracks, clips, scenes, edits, and exports in
user-facing language.

The legacy HTML runtime is currently a playback and persistence adapter. Preserve its structural contracts,
but do not expose them as prerequisites or make new editor features depend on users creating HTML.

## The current render adapter

Studio renders the current scene in an **iframe**, and draws its own
chrome — selection box, handles, dashed outlines, toolbars — in **Studio's own
document**, positioned over the iframe. Nothing Studio draws lives inside the
scene document, because a render would capture it and the scene's styling
would inherit into it.

Two consequences you will meet immediately:

- Reaching a preview element from a driver or a test means going through the
  iframe: `iframe.contentDocument.getElementById(...)`. Studio's own panels may
  be inside shadow roots, so a plain `document.querySelector` finds neither.
- Every overlay box is a _measurement_ of an element, not the element. When
  chrome disagrees with the pixels underneath it, the bug is almost always in
  the measurement, in `components/editor/domEditOverlayGeometry.ts`.

## Driving Studio for verification

A pixel-precise click inside the preview is not something an automated driver
can reliably land, and some gestures cannot be synthesised at all: the canvas
overlay takes pointer capture and recognises a double press itself, so
`page.mouse` click pairs do not open a text edit no matter how they are timed.

Use the dev-only hook instead. In a dev build `window.__studioTest` exposes:

```js
await window.__studioTest.selectByDomId("headline"); // selects, reveals the inspector
```

That is the same selection a click produces. The general lesson: from a settled
selection, keyboard paths are dependable where pointer paths are not. Prefer a
key over a synthesised gesture whenever the feature offers one.

`useStudioTestHooks` also carries the timeline performance fixtures. The hook is
gated on `STUDIO_TEST_HOOKS_ENABLED` (dev or development mode only), so
`window.__studioTest` is absent in production builds — feature-detect it.

## Tracing decisions

The interesting failures here are decisions, not crashes: a preview that
reloads when it should not, a shift-click that selects the wrong element.
Nothing throws, so a trace of the decision is the only way to avoid guessing.

Channels are off by default. Turn one on and reload:

```js
localStorage.setItem("hf-drag-debug", "1"); // then grep the console for [hf-drag]
```

Live channels: `reload`, `select`, `drag`, `resize`, `commit`. Add one with
`makeStudioDebugLogger("<name>")` in `utils/studioDebug.ts`.

## Running the tests

Studio's tests are **vitest**. Use the package's npm scripts so the configured
runner and setup files are applied:

```bash
npm test -- src/components/editor # one directory
npm test                          # all tests
npm run typecheck
npm run build
```

happy-dom is not a browser. It does not reflect the individual transform
properties (`rotate`, `scale`, `translate`) into computed style, and it has no
`DOMMatrix` — the geometry tests carry their own stand-in. When a behaviour
depends on real layout or real computed style, prove it in a browser and keep
the unit test on the pure function underneath.

## Local quality gates

- Add or strengthen a behavioral test before implementation, and confirm the red state.
- Run focused tests, then `npm run typecheck` and `npm run build`.
- Treat `fixtures/**` and `.hyperframes` recovery data as user-owned.

## Traps worth knowing

- **`rotate` is not `transform`.** Studio's rotate handle writes the CSS
  `rotate` property, which is an individual transform property and does not
  appear in `getComputedStyle(el).transform`. Anything measuring an angle has to
  read both and compose them the way CSS does, individual properties first.
- **A seek re-renders the whole timeline**, not the tween you patched. Patching
  several elements one at a time and seeking after each repaints the ones still
  queued from their un-patched tweens. Batch, then render once.
- **Studio's own writes must not reload the preview.** Writes carry a token so
  the file-watcher event can be recognised as ours; a new write path that
  forgets it makes the preview flash on every edit.
- **Preserving a selection set that does not contain the id empties it.** Check
  `preserveSet` semantics before reusing it.
