import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { isValidPassword } from '../../../core/utils/validation';
import { useFixes } from '../../../hooks';
import { Button, PASSWORD_INPUT_MAX_UNITS, TextField } from '../../components';
import { describeError, type ErrorMessages } from '../../presentation/errors';
import { colors, spacing, typography } from '../../theme';

const RESET_ERRORS: ErrorMessages = {
  invalid_credentials: 'Wrong password.',
  validation_error: 'Wrong password.',
};

/**
 * §9 step 1, "I lost my other devices — reset my security identity": a new identity key for the
 * account. Destructive for the user's trust relationships, so it is collapsed by default, explains the
 * consequences and needs the password.
 */
export function ResetIdentityPanel() {
  const { session } = useFixes();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setPassword('');
    setError(null);
  };

  const reset = async () => {
    if (busy) return;
    if (!isValidPassword(password)) {
      setError('Enter your password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // On success the session becomes 'ready' and the root navigator opens the inbox.
      await session.resetIdentity(password);
    } catch (caught) {
      setError(describeError(caught, RESET_ERRORS));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button
        title="I lost my other devices — reset my security identity"
        variant="link"
        onPress={() => setOpen(true)}
        testID="reset-identity-open"
      />
    );
  }

  return (
    <View style={styles.panel} testID="reset-identity-panel">
      <Text style={styles.heading} accessibilityRole="header">
        Reset your security identity
      </Text>
      <Text style={styles.warning}>
        Only do this if you can no longer use any device where you are logged in to Fixes.
      </Text>
      <Text style={styles.item}>• Your contacts will see that your safety code changed.</Text>
      <Text style={styles.item}>• All your other devices will be logged out.</Text>
      <Text style={styles.item}>• Messages stored only on your other devices cannot be moved to this phone.</Text>
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="current-password"
        textContentType="password"
        maxLength={PASSWORD_INPUT_MAX_UNITS}
        editable={!busy}
        onSubmitEditing={() => void reset()}
        testID="reset-identity-password"
      />
      {error ? (
        <Text style={styles.error} accessibilityRole="alert" testID="reset-identity-error">
          {error}
        </Text>
      ) : null}
      <Button
        title={busy ? 'Resetting..' : 'Reset security identity'}
        variant="danger"
        busy={busy}
        onPress={() => void reset()}
        testID="reset-identity-submit"
      />
      <Button title="Cancel" variant="link" onPress={close} disabled={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 6,
  },
  heading: { ...typography.heading },
  warning: { ...typography.body, fontWeight: '600', color: colors.danger },
  item: { ...typography.body },
  error: { ...typography.body, color: colors.danger },
});
