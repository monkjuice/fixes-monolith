// Shared Jest project definitions for jest.config.js (unit tests) and jest.e2e.config.js.
const expoPreset = require('jest-expo/jest-preset');

// jest-expo resolves babel-preset-expo for us; core and e2e reuse that transform without the
// React Native test environment.
const babelTransform = expoPreset.transform['\\.[jt]sx?$'];

// ESM-only dependencies that Jest (CommonJS) must transpile.
const ESM_PACKAGES = ['@noble', '@scure'];

const nodeTransformIgnore = [`/node_modules/(?!(${ESM_PACKAGES.join('|')})/)`];

/** src/core (and the Node adapters in src/test-utils): plain Node, no React Native. */
const coreProject = {
  displayName: 'core',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/core/**/*.test.ts', '<rootDir>/src/test-utils/**/*.test.ts'],
  transform: { '\\.[jt]sx?$': babelTransform },
  transformIgnorePatterns: nodeTransformIgnore,
};

/** React Native code (src/platform, src/hooks, App, UI screens) with the jest-expo preset and native mocks. */
const appProject = {
  displayName: 'app',
  preset: 'jest-expo',
  // Jest appends these to the preset's setup files.
  setupFiles: ['<rootDir>/jest.setup.app.js'],
  testMatch: [
    '<rootDir>/src/platform/**/*.test.ts?(x)',
    '<rootDir>/src/hooks/**/*.test.ts?(x)',
    '<rootDir>/src/ui/**/*.test.ts?(x)',
    '<rootDir>/*.test.tsx',
  ],
  transformIgnorePatterns: [
    `/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|${ESM_PACKAGES.join('|')}))`,
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
};

/** End-to-end tests against a running server (FIXES_E2E_API_URL); see e2e/README.md. */
const e2eProject = {
  displayName: 'e2e',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/e2e/**/*.test.ts'],
  transform: { '\\.[jt]sx?$': babelTransform },
  transformIgnorePatterns: nodeTransformIgnore,
};

module.exports = { coreProject, appProject, e2eProject };
