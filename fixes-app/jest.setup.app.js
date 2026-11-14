// The real SafeAreaProvider renders nothing until the native module reports insets, which never
// happens under Jest; the library's own mock provides fixed metrics instead.
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// @expo/vector-icons loads its font after mounting and re-renders when done, outside any act() in a
// synchronous test. Under Jest there is no font to load, so icons start out "loaded".
jest.mock('expo-font', () => ({
  ...jest.requireActual('expo-font'),
  isLoaded: jest.fn(() => true),
  loadAsync: jest.fn(async () => undefined),
}));
