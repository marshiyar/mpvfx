# MpVFX Studio

The desktop editor lives in this directory.

```bash
npm ci
npm run desktop:dev
```

Common commands:

```bash
npm test
npm run typecheck
npm run build
npm run desktop:make
```

Platform-specific installer commands are available as `desktop:make:mac:arm64`,
`desktop:make:mac:x64`, `desktop:make:windows`, and `desktop:make:linux`.

Projects, imported media, renders, caches, and recovery files are local data and are not part of
the application source.
