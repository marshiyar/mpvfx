# Editor feedback

Owns feedback controls and the project context included by that interface.

Start with `StudioFeedbackCard.tsx`.

Follow the existing telemetry and consent policy. Do not make feedback state own editor or project state.

From `studio`, run:

```bash
npm test -- src/features/feedback
npm run check:architecture
```

See the [feature map](../README.md) and [application architecture](../../../../docs/ARCHITECTURE.md) for neighboring contracts.
