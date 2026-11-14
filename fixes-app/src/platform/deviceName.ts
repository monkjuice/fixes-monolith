import { Platform } from 'react-native';

/**
 * Human-readable name sent at login and shown on the Devices screen. Uses what React Native exposes
 * without an extra dependency (Android: brand + model; iOS: iPhone/iPad).
 */
export function platformDeviceName(): string {
  if (Platform.OS === 'android') {
    const constants = Platform.constants as { Brand?: string; Model?: string };
    const name = [constants.Brand, constants.Model].filter((part) => typeof part === 'string' && part.length > 0).join(' ');
    return name.length > 0 ? name : 'Android';
  }
  if (Platform.OS === 'ios') return Platform.isPad ? 'iPad' : 'iPhone';
  return Platform.OS;
}
