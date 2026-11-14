import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { BackupFileHandle, ImportReport } from '../../../../core/backup/backupService';
import { Topics } from '../../../../core/db/changes';
import type { LocalStore } from '../../../../core/db/localStore';
import { useLocalStore, useStoreQuery } from '../../../../hooks';
import { Banner, Button, Icon, InlineError, TextField } from '../../../components';
import { colors, spacing, statusColors, typography } from '../../../theme';

export interface NeedKeyStepProps {
  file: BackupFileHandle;
  error: string | null;
  onSubmit(recoveryKey: string): void;
  onCancel(): void;
}

function formatCreated(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString();
}

/** A picked backup passed the header and owner checks (§10); decrypting it needs the recovery key. */
export function NeedKeyStep({ file, error, onSubmit, onCancel }: NeedKeyStepProps) {
  const [recoveryKey, setRecoveryKey] = useState('');
  return (
    <View style={styles.box} testID="backup-need-key">
      <Text style={styles.heading} accessibilityRole="header">
        Restore a backup
      </Text>
      <Text style={styles.body}>{`${file.fileName}\nCreated ${formatCreated(file.createdAt)}`}</Text>
      <Text style={styles.body}>Enter the recovery key that was shown when you created your first backup.</Text>
      <TextField
        label="Recovery key"
        value={recoveryKey}
        onChangeText={setRecoveryKey}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        // 24 characters plus dashes or spaces between the groups.
        maxLength={40}
        returnKeyType="done"
        onSubmitEditing={() => onSubmit(recoveryKey)}
        testID="backup-recovery-key"
      />
      <InlineError message={error} testID="backup-import-error" />
      <Button title="Restore" onPress={() => onSubmit(recoveryKey)} testID="backup-restore" />
      <Button title="Cancel" variant="link" onPress={onCancel} />
    </View>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Names of contacts whose imported key conflicted, from the local conversations (ids otherwise). */
function useContactNames(userIds: readonly string[]): string[] {
  const store = useLocalStore();
  const key = userIds.join(',');
  const run = useCallback(
    async (s: LocalStore) => {
      const ids = key.length > 0 ? key.split(',') : [];
      const rows = await Promise.all(ids.map((id) => s.conversations.get(id)));
      return rows.map((row, i) => row?.peer_username ?? `Unknown user (${ids[i].slice(0, 8)})`);
    },
    [key],
  );
  return useStoreQuery<string[]>(store, CONVERSATION_TOPICS, run, NO_NAMES).data;
}

// Re-read after the post-import profile refresh renames placeholder conversations.
const CONVERSATION_TOPICS = [Topics.conversations];
const NO_NAMES: string[] = [];

/** §10 import summary, including contacts whose key differs from the pin on this phone. */
export function ImportedStep({ report, onDone }: { report: ImportReport; onDone(): void }) {
  const conflicts = useContactNames(report.identityConflicts);
  const nothing = report.messagesAdded === 0 && report.messagesUpdated === 0 && report.conversationsAdded === 0;
  return (
    <View style={styles.box} testID="backup-imported">
      <View style={styles.center}>
        <Icon name="checkmark-circle" size={56} color={statusColors.delivered} />
      </View>
      <Text style={styles.heading} accessibilityRole="header">
        Backup restored
      </Text>
      <Text style={styles.body} testID="backup-imported-summary">
        {nothing
          ? 'Everything in this backup was already on this phone.'
          : `${plural(report.messagesAdded, 'message', 'messages')} added, ${plural(report.messagesUpdated, 'message', 'messages')} updated, ${plural(report.conversationsAdded, 'conversation', 'conversations')} added.`}
      </Text>
      {report.skipped > 0 ? (
        <Text style={styles.body}>{`${plural(report.skipped, 'entry was', 'entries were')} invalid and skipped.`}</Text>
      ) : null}
      {report.identityConflicts.length > 0 ? (
        <Banner
          tone="warning"
          icon="shield-outline"
          text={`The backup has a different safety code for ${conflicts.join(', ')}. The code already on this phone was kept. Compare safety codes with ${report.identityConflicts.length === 1 ? 'this contact' : 'these contacts'} on their profile.`}
          testID="backup-identity-conflicts"
        />
      ) : null}
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
