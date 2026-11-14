import { CameraView, useCameraPermissions, type BarcodeScanningResult, type BarcodeSettings } from 'expo-camera';
import { useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { Button, ErrorState, LoadingState } from '../../../components';
import { colors, spacing, typography } from '../../../theme';

const FRAME_SIZE = 280;
const QR_ONLY: BarcodeSettings = { barcodeTypes: ['qr'] };

export interface QrScannerProps {
  /** Every decoded QR code while not paused (the camera reports the same code many times a second). */
  onScanned(data: string): void;
  paused: boolean;
}

/**
 * The back camera as a QR scanner (expo-camera `CameraView` with the barcode scanner enabled in
 * app.json). Asks for the camera permission with an explanation first; when the OS no longer asks,
 * points to the system settings.
 */
export function QrScanner({ onScanned, paused }: QrScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraError, setCameraError] = useState<string | null>(null);

  if (!permission) return <LoadingState label="Checking camera access" />;

  if (!permission.granted) {
    return (
      <View style={styles.permission} testID="scanner-permission">
        <Text style={styles.text}>Fixes needs the camera to scan the code shown on your new device.</Text>
        {permission.canAskAgain ? (
          <Button
            title="Allow camera"
            onPress={() => {
              requestPermission().catch((error: unknown) => console.warn('Asking for the camera permission failed', error));
            }}
            testID="scanner-allow"
          />
        ) : (
          <>
            <Text style={styles.text}>Camera access is turned off for Fixes.</Text>
            <Button
              title="Open settings"
              variant="secondary"
              onPress={() => {
                Linking.openSettings().catch((error: unknown) => console.warn('Could not open the system settings', error));
              }}
            />
          </>
        )}
      </View>
    );
  }

  if (cameraError) return <ErrorState message={`The camera could not start. ${cameraError}`} />;

  return (
    <View style={styles.frame} accessible accessibilityLabel="Camera viewfinder. Point it at the code on your new device.">
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={QR_ONLY}
        // No handler while paused: the camera keeps running but stops reporting codes.
        onBarcodeScanned={paused ? undefined : (result: BarcodeScanningResult) => onScanned(result.data)}
        onMountError={(event) => setCameraError(event.message)}
        testID="scanner-camera"
      />
      <View style={styles.corners} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  permission: { alignItems: 'center', gap: spacing.md, padding: spacing.xl },
  text: { ...typography.body, textAlign: 'center' },
  frame: {
    alignSelf: 'center',
    width: FRAME_SIZE,
    height: FRAME_SIZE,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: colors.black,
  },
  corners: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, margin: spacing.xl, borderWidth: 2, borderColor: colors.white, borderRadius: 8, opacity: 0.8 },
});
