# Media library and import

Owns asset browsing, import controls, previews, reusable blocks, and beat-analysis UI integration.

Start with `LeftSidebar.tsx`, `AssetsTab.tsx`, `MediaImportControl.tsx`.

Use shared/media/mediaImportPolicy.ts for accepted types. Runtime media/ owns codec processing; timeline/ owns placement after import.

From `studio`, run:

```bash
npm test -- src/features/media
npm run check:architecture
```

See the [feature map](../README.md) and [application architecture](../../../../docs/ARCHITECTURE.md) for neighboring contracts.
