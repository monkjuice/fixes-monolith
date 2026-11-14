import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useBackup } from '../../../hooks';
import { Button, InlineError, KeyboardAvoidingScreen, LoadingState } from '../../components';
import { colors, spacing, typography } from '../../theme';
import { ConfirmKeyStep, ExportedStep } from './backup/ExportSteps';
import { ImportedStep, NeedKeyStep } from './backup/ImportSteps';
import { RecoveryKeyView } from './backup/RecoveryKeyView';

type ShownKey = { state: 'hidden' } | { state: 'loading' } | { state: 'shown'; key: string | null } | { state: 'error'; message: string };

/**
 * §10 Backups: an encrypted file protected by the recovery key, saved through the share sheet and
 * never uploaded to the Fixes server; import by picking a file and typing the key. The first export
 * creates the key and has the user confirm it (§4.3); Settings can show it again.
 */
export function BackupScreen() {
  const backup = useBackup();
  const [shownKey, setShownKey] = useState<ShownKey>({ state: 'hidden' });

  const toggleKey = () => {
    if (shownKey.state === 'shown' || shownKey.state === 'error') {
      setShownKey({ state: 'hidden' });
      return;
    }
    setShownKey({ state: 'loading' });
    backup.viewRecoveryKey().then(
      (key) => setShownKey({ state: 'shown', key }),
      (error: unknown) => {
        console.error('Reading the recovery key failed', error);
        setShownKey({ state: 'error', message: 'The recovery key could not be read.' });
      },
    );
  };

  const errorText = backup.error?.message ?? null;
  let content;
  switch (backup.step) {
    case 'working':
      content = <LoadingState label="Working on your backup" testID="backup-working" />;
      break;
    case 'confirmKey':
      content = backup.recoveryKey ? (
        <ConfirmKeyStep
          // A new key starts the confirmation from the beginning.
          key={backup.recoveryKey}
          recoveryKey={backup.recoveryKey}
          error={errorText}
          onConfirm={(group) => void backup.confirmRecoveryKey(group)}
          onCancel={backup.reset}
        />
      ) : null;
      break;
    case 'exported':
      content = backup.exported ? <ExportedStep exported={backup.exported} onDone={backup.reset} /> : null;
      break;
    case 'needKey':
      content = backup.file ? (
        <NeedKeyStep
          key={backup.file.createdAt}
          file={backup.file}
          error={errorText}
          onSubmit={(key) => void backup.submitRecoveryKey(key)}
          onCancel={backup.reset}
        />
      ) : null;
      break;
    case 'imported':
      content = backup.imported ? <ImportedStep report={backup.imported} onDone={backup.reset} /> : null;
      break;
    case 'idle':
      content = (
        <>
          <InlineError message={errorText} testID="backup-error" />
          <View style={styles.section}>
            <Text style={styles.heading} accessibilityRole="header">
              Back up your messages
            </Text>
            <Text style={styles.body}>
              Your messages are stored only on your devices. A backup is an encrypted file that you save wherever you
              like (files, cloud drive, e-mail). It is never uploaded to the Fixes server and can only be opened with
              your recovery key.
            </Text>
            <Button title="Create backup" onPress={() => void backup.startExport()} testID="backup-create" />
          </View>

          <View style={styles.section}>
            <Text style={styles.heading} accessibilityRole="header">
              Recovery key
            </Text>
            {shownKey.state === 'shown' ? (
              shownKey.key ? (
                <RecoveryKeyView recoveryKey={shownKey.key} testID="recovery-key-again" />
              ) : (
                <Text style={styles.body} testID="recovery-key-none">
                  You do not have a recovery key yet. It is created with your first backup.
                </Text>
              )
            ) : null}
            {shownKey.state === 'error' ? <InlineError message={shownKey.message} /> : null}
            <Button
              title={shownKey.state === 'shown' ? 'Hide recovery key' : 'Show recovery key'}
              variant="secondary"
              busy={shownKey.state === 'loading'}
              onPress={toggleKey}
              testID="backup-show-recovery-key"
            />
          </View>

          <View style={styles.section}>
            <Text style={styles.heading} accessibilityRole="header">
              Restore
            </Text>
            <Text style={styles.body}>
              Pick a backup file of this account. Messages already on this phone are kept; missing ones are added.
            </Text>
            <Button title="Import backup" variant="secondary" onPress={() => void backup.startImport()} testID="backup-import" />
          </View>
        </>
      );
      break;
  }

  return (
    <KeyboardAvoidingScreen>
      <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {content}
      </ScrollView>
    </KeyboardAvoidingScreen>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  content: { padding: spacing.xl, gap: spacing.lg },
  section: { gap: spacing.md, paddingBottom: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  heading: { ...typography.heading },
  body: { ...typography.body, color: colors.textMuted },
});
