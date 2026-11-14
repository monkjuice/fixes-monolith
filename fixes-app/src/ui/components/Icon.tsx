import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export interface IconProps {
  name: IconName;
  size?: number;
  color: string;
  /** Spoken text when the icon carries meaning on its own (status ticks); decorative otherwise. */
  accessibilityLabel?: string;
  testID?: string;
}

export function Icon({ name, size = 24, color, accessibilityLabel, testID }: IconProps) {
  return (
    <Ionicons
      name={name}
      size={size}
      color={color}
      testID={testID}
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={accessibilityLabel !== undefined ? 'yes' : 'no-hide-descendants'}
    />
  );
}
