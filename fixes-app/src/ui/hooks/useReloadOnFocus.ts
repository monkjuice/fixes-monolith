import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useRef } from 'react';

/**
 * Reloads server data when the screen gains focus again (back from a screen that may have changed
 * it). The first focus is skipped: useApiQuery already loads on mount.
 */
export function useReloadOnFocus(reload: () => void): void {
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      reload();
    }, [reload]),
  );
}
