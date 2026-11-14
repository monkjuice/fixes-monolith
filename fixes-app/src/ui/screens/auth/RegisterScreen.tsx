import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isValidPassword, isValidUsername } from '../../../core/utils/validation';
import { useFixes } from '../../../hooks';
import { Button, KeyboardAvoidingScreen, Logo, PASSWORD_INPUT_MAX_UNITS, TextField, useToast } from '../../components';
import type { RootScreenProps } from '../../navigation/types';
import { describeError } from '../../presentation/errors';
import { colors, spacing, typography } from '../../theme';
import { LOGIN_ERRORS, REGISTER_ERRORS } from './authErrors';

const USERNAME_RULE = 'Usernames have 3 to 30 letters, digits or underscores.';
const PASSWORD_RULE = 'Passwords have 8 to 128 characters.';

/**
 * Legacy RegisterPage: same form as Login. §14: after the account is created the legacy toast
 * "Welcome to Fixes <username>, please login to continue!" is shown, then the app logs in by itself.
 */
export function RegisterScreen({ navigation }: RootScreenProps<'Register'>) {
  const { session } = useFixes();
  const showToast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ username: string | null; password: string | null }>({
    username: null,
    password: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordField = useRef<TextInput>(null);

  const submit = async () => {
    if (submitting) return;
    const name = username.trim();
    const errors = {
      username: isValidUsername(name) ? null : USERNAME_RULE,
      password: isValidPassword(password) ? null : PASSWORD_RULE,
    };
    setFieldErrors(errors);
    setError(null);
    if (errors.username || errors.password) return;

    setSubmitting(true);
    try {
      let registered: string;
      try {
        registered = (await session.register(name, password)).username;
      } catch (caught) {
        setError(describeError(caught, REGISTER_ERRORS));
        setPassword('');
        return;
      }
      showToast(`Welcome to Fixes ${registered}, please login to continue!`);
      try {
        // On success the session leaves 'signedOut' and the root navigator replaces this screen.
        await session.login(name, password);
      } catch (caught) {
        setError(`Your account was created, but logging in failed: ${describeError(caught, LOGIN_ERRORS)}`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingScreen>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Logo />
          <TextField
            label="Username"
            value={username}
            onChangeText={setUsername}
            error={fieldErrors.username}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username-new"
            textContentType="username"
            returnKeyType="next"
            maxLength={30}
            onSubmitEditing={() => passwordField.current?.focus()}
            submitBehavior="submit"
            editable={!submitting}
            testID="register-username"
          />
          <TextField
            ref={passwordField}
            label="Password"
            value={password}
            onChangeText={setPassword}
            error={fieldErrors.password}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            returnKeyType="go"
            maxLength={PASSWORD_INPUT_MAX_UNITS}
            onSubmitEditing={() => void submit()}
            editable={!submitting}
            testID="register-password"
          />
          {error ? (
            <Text style={styles.error} accessibilityRole="alert" testID="register-error">
              {error}
            </Text>
          ) : null}
          <Button
            title={submitting ? 'Loading..' : 'Register'}
            onPress={() => void submit()}
            disabled={submitting}
            style={styles.submit}
            testID="register-submit"
          />
          <Button title="Back to login" variant="link" onPress={() => navigation.goBack()} disabled={submitting} />
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
});
