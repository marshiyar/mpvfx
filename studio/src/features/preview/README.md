# Editor preview

Owns the preview iframe, zoom, composition navigation, and synchronization with edits.

Start with `NLEPreview.tsx`, `PreviewPane.tsx`, `usePreviewPersistence.ts`.

Editing chrome stays in the renderer document. Respect write receipts and the external-change coordinator to avoid reloading the preview after the app’s own writes.

From `studio`, run:

```bash
npm test -- src/features/preview
npm run check:architecture
```

See the [feature map](../README.md) and [application architecture](../../../../docs/ARCHITECTURE.md) for neighboring contracts.
