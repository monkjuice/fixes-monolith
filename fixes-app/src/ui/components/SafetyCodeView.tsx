import { Platform, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../theme';

const MONOSPACE = Platform.select({ ios: 'Menlo', default: 'monospace' });
const COLUMNS = 3;

export interface SafetyCodeViewProps {
  /** The 12 groups of 5 digits (§4.4). */
  groups: readonly string[];
  /** Dimmed while it is not the code in use (a changed key awaiting Accept). */
  muted?: boolean;
  testID?: string;
}

/** The safety code as a 3-column grid, easy to read aloud and compare group by group. */
export function SafetyCodeView({ groups, muted = false, testID }: SafetyCodeViewProps) {
  const rows: string[][] = [];
  for (let i = 0; i < groups.length; i += COLUMNS) rows.push(groups.slice(i, i + COLUMNS));
  return (
    <View
      style={styles.box}
      accessible
      accessibilityLabel={`Safety code: ${groups.join(', ')}`}
      testID={testID}
    >
      {/* A fixed-size grid whose groups can repeat: positions are the stable keys. */}
      {rows.map((row, rowIndex) => (
        <View key={`row-${rowIndex}`} style={styles.row}>
          {row.map((group, index) => (
            <Text key={`group-${rowIndex}-${index}`} style={[styles.group, muted && styles.muted]}>
              {group}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignSelf: 'center',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    gap: spacing.sm,
  },
  row: { flexDirection: 'row', gap: spacing.xl },
  group: { fontFamily: MONOSPACE, fontSize: 20, letterSpacing: 1, color: colors.text, fontVariant: ['tabular-nums'] },
  muted: { color: colors.textMuted },
});
