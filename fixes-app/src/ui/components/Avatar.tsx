import { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';

import { colors } from '../theme';
import { Icon } from './Icon';

export interface AvatarProps {
  uri: string | null | undefined;
  size?: number;
  testID?: string;
}

/**
 * Round profile picture (legacy 55 pt frames). §13: a missing avatar or one that fails to load shows
 * the placeholder. Decorative: rows announce the username themselves.
 */
export function Avatar({ uri, size = 55, testID }: AvatarProps) {
  // Remembering which URL failed (instead of a boolean) lets a new URL try again without an effect.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const shape = { width: size, height: size, borderRadius: size / 2 };
  const showImage = !!uri && uri !== failedUri;
  return (
    <View style={[styles.frame, shape]} importantForAccessibility="no-hide-descendants" accessible={false} testID={testID}>
      {showImage ? (
        <Image
          source={{ uri }}
          style={shape}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
          onError={() => setFailedUri(uri)}
          testID={testID ? `${testID}-image` : undefined}
        />
      ) : (
        <View testID={testID ? `${testID}-placeholder` : undefined}>
          <Icon name="person" size={size * 0.6} color={colors.white} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
