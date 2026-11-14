import type { MyDevice } from '../../core/api/types';
import { fromBase64Exact } from '../../core/crypto/encoding';
import { verifyDeviceCertificate } from '../../core/crypto/identity';
import { relativeTime } from '../../core/utils/relativeTime';

/** Devices added this recently (after this phone joined) are pointed out on the Devices screen (§8). */
export const NEW_DEVICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface DeviceView {
  device: MyDevice;
  current: boolean;
  /** Its certificate verifies under this install's AIK (checked here, not taken from the server). */
  linked: boolean;
  /** "This device", "Linked" or "Not linked". */
  status: string;
  lastSeen: string;
  /** Added after this device, within NEW_DEVICE_WINDOW_MS: worth a "was this you?" notice. */
  isNew: boolean;
}

function decodeKey(base64: string | null | undefined): Uint8Array | null {
  if (!base64) return null;
  try {
    return fromBase64Exact(base64, 32);
  } catch {
    // A malformed key from the server cannot certify anything; the device simply shows as not linked.
    return null;
  }
}

/**
 * §8: whether a device of mine is linked. `identityKey` must be the AIK this install holds (secure
 * storage), never the key the server reports: the server only stores certificates that verify under
 * the key it reports, so only a check against my own key keeps a compromised server (which could
 * report a key of its own and certify its devices with it) from making a foreign device look linked.
 * Without a local AIK nothing is shown as linked.
 */
export function isDeviceLinked(device: MyDevice, userId: string, identityKey: string | null): boolean {
  const identityPublicKey = decodeKey(identityKey);
  const devicePublicKey = decodeKey(device.public_key);
  if (!identityPublicKey || !devicePublicKey) return false;
  return verifyDeviceCertificate({
    identityPublicKey,
    userId,
    deviceId: device.id,
    devicePublicKey,
    certificate: device.certificate,
  });
}

function timeOf(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Rows for the Devices screen: this device first, then the most recently seen. `account.identityKey`
 * is this install's AIK (see isDeviceLinked).
 */
export function deviceViews(
  devices: readonly MyDevice[],
  account: { userId: string; identityKey: string | null },
  now: number,
): DeviceView[] {
  const clock = { now: () => now };
  const currentCreated = timeOf(devices.find((d) => d.current)?.created_at ?? '');
  const views = devices.map((device): DeviceView => {
    const linked = isDeviceLinked(device, account.userId, account.identityKey);
    const created = timeOf(device.created_at);
    const seen = timeOf(device.last_seen_at);
    const isNew =
      !device.current &&
      created !== null &&
      now - created <= NEW_DEVICE_WINDOW_MS &&
      (currentCreated === null || created > currentCreated);
    return {
      device,
      current: device.current,
      linked,
      status: device.current ? 'This device' : linked ? 'Linked' : 'Not linked',
      lastSeen: seen === null ? 'Last seen: unknown' : `Last seen ${relativeTime(seen, clock)}`,
      isNew,
    };
  });
  return views.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return (timeOf(b.device.last_seen_at) ?? 0) - (timeOf(a.device.last_seen_at) ?? 0);
  });
}
