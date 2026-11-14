// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// src/core runs under plain Node (Jest, e2e); platform services come in through src/core/platform.ts.
const NO_PLATFORM_IN_CORE = [
  {
    group: [
      'react',
      'react/*',
      'react-native',
      'react-native/*',
      'react-native-*',
      'expo',
      'expo/*',
      'expo-*',
      '@expo/*',
      '@react-navigation/*',
    ],
    message: 'src/core must not depend on React, React Native or Expo; inject a platform service instead.',
  },
  {
    group: ['../../platform/*', '../../../platform/*', '../../../../platform/*'],
    message: 'src/core must not import the Expo adapters in src/platform.',
  },
];

// The Node adapters (better-sqlite3, ws, fs) must never reach the app bundle.
const NO_TEST_UTILS = [
  { group: ['**/test-utils', '**/test-utils/**'], message: 'src/test-utils is for tests and the e2e suite only.' },
];

// Screens get their services from FixesProvider (App.tsx passes getAppServices()), so tests can render
// them with fakes or a test phone; importing the Expo adapters directly would bypass that.
const NO_PLATFORM_IN_UI = [
  {
    group: ['../platform/*', '../../platform/*', '../../../platform/*', '../../../../platform/*'],
    message: 'src/ui gets services through FixesProvider (src/hooks); only App.tsx wires src/platform.',
  },
];

const TESTS = ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx'];

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'coverage/*', 'android/*', 'ios/*', '.expo/*'],
  },
  // Flat config replaces (does not merge) a rule's options per file, so the blocks below never overlap.
  {
    files: ['src/core/**/*.ts'],
    ignores: TESTS,
    rules: { 'no-restricted-imports': ['error', { patterns: [...NO_PLATFORM_IN_CORE, ...NO_TEST_UTILS] }] },
  },
  {
    files: TESTS.map((pattern) => `src/core/${pattern}`),
    rules: { 'no-restricted-imports': ['error', { patterns: NO_PLATFORM_IN_CORE }] },
  },
  {
    files: ['src/platform/**/*.ts', 'src/platform/**/*.tsx', 'src/hooks/**/*.ts', 'src/hooks/**/*.tsx', 'App.tsx', 'index.ts'],
    ignores: TESTS,
    rules: { 'no-restricted-imports': ['error', { patterns: NO_TEST_UTILS }] },
  },
  {
    files: ['src/ui/**/*.ts', 'src/ui/**/*.tsx'],
    ignores: TESTS,
    rules: { 'no-restricted-imports': ['error', { patterns: [...NO_TEST_UTILS, ...NO_PLATFORM_IN_UI] }] },
  },
]);
