/**
 * The native settings app.json produces (README "Security-relevant native settings"), checked on the
 * AndroidManifest the prebuild would generate (introspection: nothing is written).
 */
import { compileModsAsync } from '@expo/config-plugins';
import { getPrebuildConfigAsync } from '@expo/prebuild-config';
import path from 'node:path';

const projectRoot = path.resolve(__dirname, '../../..');

jest.setTimeout(60_000);

interface PermissionEntry {
  $: Record<string, string>;
}

async function androidManifest() {
  // Prebuild warnings about unrelated optional features (e.g. expo-system-ui) are not under test.
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  let config;
  try {
    const { exp } = await getPrebuildConfigAsync(projectRoot, { platforms: ['android'] });
    config = await compileModsAsync(exp, {
      projectRoot,
      platforms: ['android'],
      introspect: true,
      assertMissingModProviders: false,
    });
  } finally {
    warn.mockRestore();
  }
  const modResults = (config as unknown as { _internal: { modResults: { android: { manifest: { manifest: Record<string, unknown> } } } } })
    ._internal.modResults;
  return modResults.android.manifest.manifest;
}

describe('Android manifest (app.json)', () => {
  it('keeps only the permissions the app uses and disables OS backups', async () => {
    const manifest = await androidManifest();
    const permissions = (manifest['uses-permission'] as PermissionEntry[]).map((p) => p.$);
    const removed = permissions.filter((p) => p['tools:node'] === 'remove').map((p) => p['android:name']);
    const kept = permissions.filter((p) => p['tools:node'] !== 'remove').map((p) => p['android:name']);
    // Template permissions nothing in the app uses (no overlay, no vibration), and the microphone.
    expect(removed.sort()).toEqual(
      ['android.permission.RECORD_AUDIO', 'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.VIBRATE'].sort(),
    );
    // expo-image-picker's camera path needs WRITE_EXTERNAL_STORAGE granted on API 24-28: not blocked.
    expect(kept).toEqual(
      expect.arrayContaining(['android.permission.INTERNET', 'android.permission.CAMERA', 'android.permission.WRITE_EXTERNAL_STORAGE']),
    );
    const application = (manifest.application as PermissionEntry[])[0].$;
    expect(application['android:allowBackup']).toBe('false');
  });
});
