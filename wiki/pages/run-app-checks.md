---
title: Run the app checks
type: guide
summary: "fixes-app checks that need no device or native toolchain: npx tsc --noEmit, npx expo lint, npx jest (core + app projects, 505 tests as of 2026-11-13) and npx expo export --platform android."
tags: [v2, app, guide, testing]
sources: []
updated: 2026-11-13
---

# Run the app checks

From `fixes-app/` (Node `^20.19.4`, npm 10; exact versions pinned, lockfile committed), after installing dependencies:

```sh
npx tsc --noEmit                 # npm run typecheck
npx expo lint                    # npm run lint; also enforces the src/core / src/ui import rules
npx jest                         # npm test: projects core (Node) and app (jest-expo), 505 tests as of 2026-11-13
npx expo export --platform android --output-dir <dir outside the project>   # proves Metro can bundle
```

- None of these needs the Android SDK, Xcode, a device or a server.
- `npx expo install --check` should report the tree as up to date ([Expo SDK 57, not 58](expo-sdk-57-pin.md)).
- `npx jest` does not run the e2e suite: [Run the e2e suite](run-e2e-suite.md).
- UI tests: `renderScreen()` (`src/ui/__tests__/support/renderScreen.tsx`) with `createFakeServices()` or a real
  `createTestPhone(new FakeFixesServer())`; let lists settle inside `act()` to avoid VirtualizedList act() warnings.

Related: [fixes-app](fixes-app.md), [Make a development build](app-development-build.md),
[Windows development environment notes](windows-dev-environment-notes.md).
