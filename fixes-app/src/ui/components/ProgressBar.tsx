import { StyleSheet, View } from 'react-native';

import { colors } from '../theme';

export interface ProgressBarProps {
  /** 0…1; values outside are clamped. */
  progress: number;
  /** Spoken with the percentage ("History sent, 40 %"). */
  label: string;
  testID?: string;
}

export function ProgressBar({ progress, label, testID }: ProgressBarProps) {
  const value = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const percent = Math.round(value * 100);
  return (
    <View
      style={styles.track}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: percent }}
      testID={testID}
    >
      <View style={[styles.fill, { width: `${percent}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden', width: '100%' },
  fill: { height: '100%', backgroundColor: colors.black },
});
