import { Pressable, StyleSheet } from 'react-native';

import { colors } from '../theme';
import { Icon, type IconName } from './Icon';

export interface FABProps {
  icon: IconName;
  accessibilityLabel: string;
  onPress(): void;
  testID?: string;
}

const SIZE = 60;

/** Legacy black floating action button in the bottom-right corner. */
export function FAB({ icon, accessibilityLabel, onPress, testID }: FABProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.fab, pressed && styles.pressed]}
    >
      <Icon name={icon} size={28} color={colors.white} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 24,
    bottom: 24,
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: colors.black,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: colors.black,
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  pressed: { opacity: 0.8 },
});
