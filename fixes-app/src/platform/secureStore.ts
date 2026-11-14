import * as SecureStore from 'expo-secure-store';

import type { SecureKeyValueStore } from '../core/platform';

/**
 * Every item is readable only while the device is unlocked and never migrates to another device
 * through iCloud/iTunes backups (protocol §12.1).
 */
export const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const expoSecureStore: SecureKeyValueStore = {
  getItem: (key) => SecureStore.getItemAsync(key, SECURE_STORE_OPTIONS),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, SECURE_STORE_OPTIONS),
  deleteItem: (key) => SecureStore.deleteItemAsync(key, SECURE_STORE_OPTIONS),
};
