import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isValidPassword, isValidUsername } from '../../../core/utils/validation';
import { useFixes, useSession } from '../../../hooks';
import { Banner, Button, KeyboardAvoidingScreen, Logo, PASSWORD_INPUT_MAX_UNITS, TextField } from '../../components';
import type { RootScreenProps } from '../../navigation/types';
import { describeError } from '../../presentation/errors';
import { colors, spacing, typography } from '../../theme';
import { INVALID_CREDENTIALS, LOGIN_ERRORS, signedOutNotice } from './authErrors';

/**
 * Legacy LoginPage (§14): logo, username, password, Login ("Loading.." and disabled while working),
 * "or", Create account. On success the root navigator leaves this screen by itself (session status).
 */
export function LoginScreen({ navigation }: RootScreenProps<'Login'>) {
  const { session } = useFixes();
  const { signedOutReason } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordField = useRef<TextInput>(null);
  const notice = signedOutNotice(signedOutReason);

  const submit = async () => {
    if (submitting) return;
    const name = username.trim();
    if (name.length === 0 || password.length === 0) {
      setError('Enter your username and password.');
      return;
    }
    // A malformed username or password can never log in; say so without a round trip.
    if (!isValidUsername(name) || !isValidPassword(password)) {
      setError(INVALID_CREDENTIALS);
      setPassword('');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await session.login(name, password);
    } catch (caught) {
      setError(describeError(caught, LOGIN_ERRORS));
      // Legacy behaviour: the password field is cleared after a failed attempt.
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingScreen>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Logo />
          {notice ? <Banner text={notice} tone="warning" icon="log-out-outline" testID="signed-out-notice" /> : null}
          <TextField
            label="Username"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            returnKeyType="next"
            maxLength={30}
            onSubmitEditing={() => passwordField.current?.focus()}
            submitBehavior="submit"
            editable={!submitting}
            testID="login-username"
          />
          <TextField
            ref={passwordField}
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            maxLength={PASSWORD_INPUT_MAX_UNITS}
            onSubmitEditing={() => void submit()}
            editable={!submitting}
            testID="login-password"
          />
          {error ? (
            <Text style={styles.error} accessibilityRole="alert" testID="login-error">
              {error}
            </Text>
          ) : null}
          <Button
            title={submitting ? 'Loading..' : 'Login'}
            onPress={() => void submit()}
            disabled={submitting}
            style={styles.submit}
            testID="login-submit"
          />
          <Text style={styles.or}>or</Text>
          <Button
            title="Create account"
            variant="link"
            onPress={() => navigation.navigate('Register')}
            disabled={submitting}
            testID="login-register"
          />
        </ScrollView>
      </KeyboardAvoidingScreen>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.white },
  content: { paddingTop: 50, paddingHorizontal: spacing.xl, paddingBottom: spacing.xl, gap: spacing.lg },
  error: { ...typography.body, color: colors.danger, textAlign: 'center' },
  submit: { alignSelf: 'center', minWidth: 200, marginTop: spacing.sm },
  or: { ...typography.body, textAlign: 'center' },
});
