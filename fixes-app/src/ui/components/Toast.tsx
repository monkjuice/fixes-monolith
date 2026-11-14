import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '../theme';

/** Android's Toast.LENGTH_LONG, the legacy `LongAlert`. */
export const TOAST_LONG_MS = 3500;

type ShowToast = (text: string, durationMs?: number) => void;

const ToastContext = createContext<ShowToast | null>(null);

/**
 * Cross-platform replacement for the legacy Android toast. It lives above the navigator, so a toast
 * survives the screen change that often follows it (Register → automatic login).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();

  const show = useCallback<ShowToast>((message, durationMs = TOAST_LONG_MS) => {
    if (timer.current) clearTimeout(timer.current);
    setText(message);
    // VoiceOver has no live regions; Android reads the toast through accessibilityLiveRegion below.
    AccessibilityInfo.announceForAccessibility(message);
    timer.current = setTimeout(() => {
      timer.current = null;
      setText(null);
    }, durationMs);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      {text !== null ? (
        <View pointerEvents="none" style={[styles.container, { bottom: insets.bottom + 72 }]}>
          <View style={styles.toast} accessibilityLiveRegion="polite" testID="toast">
            <Text style={styles.text}>{text}</Text>
          </View>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside <ToastProvider>');
  return show;
}

const styles = StyleSheet.create({
  container: { position: 'absolute', left: spacing.lg, right: spacing.lg, alignItems: 'center' },
  toast: {
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    borderRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  text: { color: colors.white, fontSize: 15, textAlign: 'center' },
});
