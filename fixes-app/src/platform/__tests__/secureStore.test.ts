import * as SecureStore from 'expo-secure-store';

import { expoSecureStore } from '../secureStore';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(async () => 'value'),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

describe('expoSecureStore', () => {
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

  it('uses WHEN_UNLOCKED_THIS_DEVICE_ONLY for every operation (§12.1)', async () => {
    await expect(expoSecureStore.getItem('fixes.session')).resolves.toBe('value');
    await expoSecureStore.setItem('fixes.session', '{}');
    await expoSecureStore.deleteItem('fixes.session');
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith('fixes.session', options);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('fixes.session', '{}', options);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('fixes.session', options);
  });
});
