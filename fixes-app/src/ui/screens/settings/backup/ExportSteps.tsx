import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ExportResult } from '../../../../core/backup/backupService';
import { Button, Icon, InlineError, TextField } from '../../../components';
import { colors, spacing, statusColors, typography } from '../../../theme';
import { RecoveryKeyView } from './RecoveryKeyView';

export interface ConfirmKeyStepProps {
  recoveryKey: string;
  error: string | null;
  onConfirm(lastGroup: string): void;
  onCancel(): void;
}

/**
 * First export (§4.3): show the new recovery key, then hide it and ask for its last group, so the
 * export only completes once the user has really written the key down.
 */
export function ConfirmKeyStep({ recoveryKey, error, onConfirm, onCancel }: ConfirmKeyStepProps) {
  const [stage, setStage] = useState<'show' | 'confirm'>('show');
  const [lastGroup, setLastGroup] = useState('');

  if (stage === 'show') {
    return (
      <View style={styles.box} testID="backup-show-key">
        <Text style={styles.heading} accessibilityRole="header">
          Your recovery key
        </Text>
        <Text style={styles.body}>
          Write this key down and keep it somewhere safe, apart from your backup files. Without it a backup cannot be
          opened, and nobody (not even Fixes) can recover it for you.
        </Text>
        <RecoveryKeyView recoveryKey={recoveryKey} testID="recovery-key" />
        <Button title="I wrote it down" onPress={() => setStage('confirm')} testID="backup-key-written" />
        <Button title="Cancel" variant="link" onPress={onCancel} />
      </View>
    );
  }

  return (
    <View style={styles.box} testID="backup-confirm-key">
      <Text style={styles.heading} accessibilityRole="header">
        Confirm your recovery key
      </Text>
      <Text style={styles.body}>Type the last group of 4 characters of the key you wrote down.</Text>
      <TextField
        label="Last group (4 characters)"
        value={lastGroup}
        onChangeText={setLastGroup}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        maxLength={9}
        returnKeyType="done"
        onSubmitEditing={() => onConfirm(lastGroup)}
        testID="backup-last-group"
      />
      <InlineError message={error} testID="backup-confirm-error" />
      <Button title="Confirm and create backup" onPress={() => onConfirm(lastGroup)} testID="backup-confirm" />
      <Button title="Show the key again" variant="link" onPress={() => setStage('show')} />
      <Button title="Cancel" variant="link" onPress={onCancel} />
    </View>
  );
}

/** After the share sheet closed: what the file holds. */
export function ExportedStep({ exported, onDone }: { exported: ExportResult; onDone(): void }) {
  return (
    <View style={styles.box} testID="backup-exported">
      <View style={styles.center}>
        <Icon name="checkmark-circle" size={56} color={statusColors.delivered} />
      </View>
      <Text style={styles.heading} accessibilityRole="header">
        Backup created
      </Text>
      <Text style={styles.body} testID="backup-exported-summary">
        {`${exported.fileName}: ${exported.conversations} ${exported.conversations === 1 ? 'conversation' : 'conversations'}, ${exported.messages} ${exported.messages === 1 ? 'message' : 'messages'}.`}
      </Text>
      <Text style={styles.body}>
        If you did not save the file from the share sheet, create the backup again. Keep the file and your recovery
        key in different places.
      </Text>
      <Button title="Done" onPress={onDone} testID="backup-done" />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.md, alignItems: 'stretch' },
  center: { alignItems: 'center' },
  heading: { ...typography.title, textAlign: 'center' },
  body: { ...typography.body, color: colors.text, textAlign: 'center' },
});
