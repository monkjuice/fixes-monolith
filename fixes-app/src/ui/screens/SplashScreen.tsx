import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useFixes, useSession } from '../../hooks';
import { Button, Logo } from '../components';
import { useLogout } from '../hooks/useLogout';
import { NO_INTERNET } from '../presentation/errors';
import { colors, spacing, typography } from '../theme';

/**
 * Session status 'loading': restoring the stored session, or logging in. Offline launches keep
 * retrying with backoff (§12.1 stores nothing that could be trusted offline); other failures offer
 * Retry and, since the session exists, Log Out.
 */
export function SplashScreen() {
  const { session } = useFixes();
  const state = useSession();
  const { logout, busy: loggingOut, error: logoutError } = useLogout();
  const [retrying, setRetrying] = useState(false);

  const retry = () => {
    setRetrying(true);
    session
      .retry()
      .catch((error: unknown) => console.error('Retrying the session failed', error))
      .finally(() => setRetrying(false));
  };

  return (
    <SafeAreaView style={styles.container}>
      <Logo />
      {state.error ? (
        <View style={styles.block}>
          <Text style={styles.error} accessibilityRole="alert">
            {state.error}
          </Text>
          <Button title="Retry" onPress={retry} busy={retrying} />
          <Button title="Log Out" variant="link" onPress={logout} busy={loggingOut} />
          {logoutError ? <Text style={styles.error}>{logoutError}</Text> : null}
        </View>
      ) : (
        <View style={styles.block}>
          <ActivityIndicator color={colors.black} size="large" accessibilityLabel="Loading" />
          {state.offline ? (
            <>
              <Text style={styles.detail} accessibilityRole="alert">
                {`${NO_INTERNET} — retrying…`}
              </Text>
              <Button title="Retry now" variant="link" onPress={retry} busy={retrying} />
            </>
          ) : null}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  block: { marginTop: spacing.xl, alignItems: 'center', gap: spacing.md },
  detail: { ...typography.body, color: colors.textMuted, textAlign: 'center' },
  error: { ...typography.body, color: colors.danger, textAlign: 'center' },
});
