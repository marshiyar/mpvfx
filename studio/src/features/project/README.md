# Native project integration

Owns loaded native sessions, bootstrap from existing projects, preview application, and multi-file editing transactions.

Start with `useNativeProjectSession.ts`, `nativeProjectPersistence.ts`, `nativeTimelineTransactionCommit.ts`.

Import schema, commands, and plans from shared/project/. This feature adapts those rules to renderer, history, and player lifecycles; do not move those dependencies into shared rules.

From `studio`, run:

```bash
npm test -- src/features/project
npm run check:architecture
```

See the [feature map](../README.md) and [application architecture](../../../../docs/ARCHITECTURE.md) for neighboring contracts.
