# Property inspector

Owns property-panel UI, color grading, audio effects, and control/reset behavior.

Start with `PropertyPanel.tsx`, `PropertyPanelFlat.tsx`, `useColorGradingController.ts`.

Controls emit the existing editing operations; they do not own another durable project store. Coordinate property names and keyframe intent with animation and shared project plans.

From `studio`, run:

```bash
npm test -- src/features/inspector
npm run check:architecture
```

See the [feature map](../README.md) and [application architecture](../../../../docs/ARCHITECTURE.md) for neighboring contracts.
