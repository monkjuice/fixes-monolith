import { useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, StyleSheet, View } from 'react-native';

/**
 * KeyboardAvoidingView compares its frame (relative to its parent) with the keyboard's screen
 * position, so below a navigation header it needs the parent's distance from the top of the window
 * as `keyboardVerticalOffset`. It is measured here instead of hard-coding a header height.
 * 'padding' is used on both platforms because Android apps are edge-to-edge (Expo SDK 54+), where the
 * window is no longer resized for the keyboard.
 */
export function KeyboardAvoidingScreen({ children }: { children: ReactNode }) {
  const container = useRef<View>(null);
  const [offset, setOffset] = useState(0);
  return (
    <View
      ref={container}
      style={styles.fill}
      onLayout={() => container.current?.measureInWindow((_x, y) => setOffset(Math.max(0, y)))}
    >
      <KeyboardAvoidingView style={styles.fill} behavior="padding" keyboardVerticalOffset={offset}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
