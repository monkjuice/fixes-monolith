import { NavigationContainer } from '@react-navigation/native';
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { FixesProvider, useFixes, type FixesServices } from '../hooks';
import { Button, Logo, ToastProvider, TransferKeepAwake } from './components';
import { FriendRequestCountProvider } from './hooks/useFriendRequestCount';
import { RootNavigator } from './navigation/RootNavigator';
import { navigationTheme } from './navigation/navigationTheme';
import { colors, spacing, typography } from './theme';

/** The whole UI for a set of services (the app passes getAppServices(); tests pass fakes). */
export function FixesApp({ services }: { services: FixesServices }) {
  return (
    <SafeAreaProvider>
      <FixesProvider services={services}>
        <ToastProvider>
          <SessionStart>
            <TransferKeepAwake />
            <FriendRequestCountProvider>
              <NavigationContainer theme={navigationTheme}>
                <RootNavigator />
              </NavigationContainer>
            </FriendRequestCountProvider>
          </SessionStart>
        </ToastProvider>
      </FixesProvider>
    </SafeAreaProvider>
  );
}

/**
 * Starts the session once (RNG self-test, restore). A failure here is local (secure storage, the
 * random generator), so there is nothing to navigate to: the app shows it with a retry.
 */
function SessionStart({ children }: { children: ReactNode }) {
  const { session } = useFixes();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    session.start().catch((error: unknown) => {
      console.error('Starting the session failed', error);
      if (current) setFailed(true);
    });
    return () => {
      current = false;
    };
  }, [session, attempt]);

  if (failed) {
    return (
      <StartupError
        message="Fixes could not start on this device."
        onRetry={() => {
          setFailed(false);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  return children;
}

/** Shown when the app cannot start at all (configuration or local storage problems). */
export function StartupError({ message, onRetry }: { message: string; onRetry?(): void }) {
  return (
    <SafeAreaView style={styles.page}>
      <Logo />
      <Text style={styles.error} accessibilityRole="alert">
        {message}
      </Text>
      {onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} /> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.lg },
  error: { ...typography.body, color: colors.danger, textAlign: 'center' },
});
