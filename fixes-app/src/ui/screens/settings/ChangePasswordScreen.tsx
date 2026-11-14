import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, type TextInput } from 'react-native';

import { useFixes } from '../../../hooks';
import { Banner, Button, InlineError, KeyboardAvoidingScreen, PASSWORD_INPUT_MAX_UNITS, TextField, useToast } from '../../components';
import type { RootScreenProps } from '../../navigation/types';
import { describeError } from '../../presentation/errors';
import {
  hasPasswordErrors,
  NO_PASSWORD_ERRORS,
  PASSWORD_RULE,
  validatePasswordChange,
  type PasswordChangeErrors,
} from '../../presentation/passwordChange';
import { colors, spacing } from '../../theme';

/**
 * `POST /v1/auth/password` (§5.3). The server revokes every other device of the account (§5.4): they
 * are signed out and envelopes still waiting for them are deleted, which the screen says up front.
 */
export function ChangePasswordScreen({ navigation }: RootScreenProps<'ChangePassword'>) {
  const { session } = useFixes();
  const showToast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<PasswordChangeErrors>(NO_PASSWORD_ERRORS);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nextField = useRef<TextInput>(null);
  const repeatField = useRef<TextInput>(null);

  const submit = async () => {
    if (saving) return;
    const found = validatePasswordChange(current, next, repeat);
    setErrors(found);
    setError(null);
    if (hasPasswordErrors(found)) return;
    setSaving(true);
    try {
      await session.api.changePassword(current, next);
    } catch (caught) {
      setSaving(false);
      setCurrent('');
      setError(
        describeError(caught, {
          invalid_credentials: 'Your current password is wrong.',
          validation_error: PASSWORD_RULE,
        }),
      );
      return;
    }
    setSaving(false);
    showToast('Password changed. Your other devices were signed out.');
    navigation.goBack();
  };

  return (
    <KeyboardAvoidingScreen>
      <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Banner
          tone="warning"
          icon="warning-outline"
          text="Changing your password signs out all your other devices. Messages that have not reached them yet are lost on those devices (this phone keeps its copies). Log in and link them again afterwards."
          testID="change-password-warning"
        />
        <TextField
          label="Current password"
          value={current}
          onChangeText={setCurrent}
          error={errors.current}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          maxLength={PASSWORD_INPUT_MAX_UNITS}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => nextField.current?.focus()}
          editable={!saving}
          testID="change-password-current"
        />
        <TextField
          ref={nextField}
          label="New password"
          value={next}
          onChangeText={setNext}
          error={errors.next}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          maxLength={PASSWORD_INPUT_MAX_UNITS}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => repeatField.current?.focus()}
          editable={!saving}
          testID="change-password-new"
        />
        <TextField
          ref={repeatField}
          label="Repeat new password"
          value={repeat}
          onChangeText={setRepeat}
          error={errors.repeat}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          maxLength={PASSWORD_INPUT_MAX_UNITS}
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          editable={!saving}
          testID="change-password-repeat"
        />
        <InlineError message={error} testID="change-password-error" />
        <Button
          title={saving ? 'Changing..' : 'Change password'}
          onPress={() => void submit()}
          busy={saving}
          testID="change-password-submit"
        />
      </ScrollView>
    </KeyboardAvoidingScreen>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  content: { padding: spacing.xl, gap: spacing.lg },
});
