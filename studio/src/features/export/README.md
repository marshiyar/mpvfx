# Export interface

Owns output settings, render queue state, progress, and cancellation controls.

Start with `RenderQueue.tsx`, `useRenderQueue.ts`.

Use shared/export/exportPolicy.ts for formats and dimensions. Submit jobs through the local API; runtime/export/ owns encoding and render jobs.

From `studio`, run:

```bash
npm test -- src/features/export
npm run check:architecture
```

See the [feature map](../README.md) and [application architecture](../../../../docs/ARCHITECTURE.md) for neighboring contracts.
