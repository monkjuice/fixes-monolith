import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { fromBase64Exact } from '../../../core/crypto/encoding';
import { safetyCodeGroups } from '../../../core/crypto/safetyCode';
import { useContactIdentity, useFixes, useOwnIdentityKey } from '../../../hooks';
import { Banner, Button, EmptyState, ErrorState, Icon, InlineError, LoadingState, SafetyCodeView } from '../../components';
import type { RootScreenProps } from '../../navigation/types';
import { describeError } from '../../presentation/errors';
import { colors, spacing, statusColors, typography } from '../../theme';

/** §4.4 code for my AIK and a contact's, or null when a key is missing or malformed. */
function codeFor(myKey: string | null | undefined, theirKey: string | null | undefined): string[] | null {
  if (!myKey || !theirKey) return null;
  try {
    return safetyCodeGroups(fromBase64Exact(myKey, 32), fromBase64Exact(theirKey, 32));
  } catch (error) {
    // Keys come from secure storage and the local pin, both validated on the way in: this is a bug.
    console.error('Could not compute a safety code', error);
    return null;
  }
}

/**
 * "Security" on a contact's profile (§4.4, §8): the safety code both users see, and "Mark as
 * verified" after comparing it. While a changed key awaits acceptance, the new code is shown with
 * Accept, so it can be compared before sending resumes. My side of the code is the AIK this install
 * holds, and only while the server reports the same key for the account: with a key the server chose,
 * a server substituting both users' keys could make the two codes match.
 */
export function SecurityScreen({ route }: RootScreenProps<'Security'>) {
  const { userId, username } = route.params;
  const { messaging } = useFixes();
  const own = useOwnIdentityKey();
  const identity = useContactIdentity(userId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = username ?? 'this contact';

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action()
      .catch((caught: unknown) => setError(describeError(caught)))
      .finally(() => setBusy(false));
  };

  const pin = identity.data;
  if (identity.error && !pin) {
    return <ErrorState message="The safety code could not be loaded." onRetry={identity.reload} />;
  }
  if ((identity.loading && !pin) || own.loading) return <LoadingState label="Loading the safety code" />;
  if (!own.publicKey || !own.matchesAccount) {
    return (
      <View style={styles.page}>
        <EmptyState
          icon="warning-outline"
          title="Safety code unavailable"
          message={
            own.publicKey
              ? 'The security identity on this phone does not match the one the server reports for your account. Do not compare safety codes or mark contacts as verified until this phone is linked again.'
              : 'This phone does not hold your security identity yet, so it cannot show safety codes. Receive it from one of your linked devices with Settings › Receive history.'
          }
          testID="security-identity-warning"
        />
      </View>
    );
  }
  if (!pin) {
    return (
      <View style={styles.page}>
        <EmptyState
          icon="shield-outline"
          title="No safety code yet"
          message={`A safety code appears once you and ${name} have exchanged a message. You will both see the same code.`}
          testID="security-no-code"
        />
      </View>
    );
  }

  const pendingKey = pin.pending_identity_key;
  const groups = codeFor(own.publicKey, pendingKey ?? pin.identity_key);
  if (!groups) return <ErrorState message="The safety code could not be shown." />;
  const verified = !pendingKey && pin.verified === 1;

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      {pendingKey ? (
        <Banner
          tone="warning"
          icon="shield-outline"
          text={`${name}'s safety code changed, usually because they reset their security identity. Compare the new code below with ${name}, then accept it to keep messaging.`}
          testID="security-pending"
        />
      ) : null}
      <Text style={styles.heading} accessibilityRole="header">
        {pendingKey ? 'New safety code' : 'Safety code'}
      </Text>
      <SafetyCodeView groups={groups} testID="safety-code" />
      <Text style={styles.body}>
        {`Compare these numbers with ${name} in person or on a call. If they match on both phones, nobody can read your messages in between.`}
      </Text>

      {pendingKey ? (
        <Button
          title={busy ? 'Accepting..' : 'Accept new safety code'}
          onPress={() => run(() => messaging.acceptIdentityChange(userId))}
          busy={busy}
          testID="security-accept"
        />
      ) : (
        <>
          <View style={styles.status} testID="security-status">
            <Icon
              name={verified ? 'shield-checkmark' : 'shield-outline'}
              size={22}
              color={verified ? statusColors.delivered : colors.textMuted}
            />
            <Text style={styles.statusText}>{verified ? `You have verified ${name}.` : 'Not verified yet.'}</Text>
          </View>
          <Button
            title={verified ? 'Mark as not verified' : 'Mark as verified'}
            variant={verified ? 'secondary' : 'primary'}
            onPress={() => run(() => messaging.setContactVerified(userId, !verified))}
            busy={busy}
            testID="security-toggle-verified"
          />
        </>
      )}
      <InlineError message={error} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  content: { padding: spacing.xl, gap: spacing.lg },
  heading: { ...typography.heading, textAlign: 'center' },
  body: { ...typography.body, color: colors.textMuted, textAlign: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  statusText: { ...typography.body },
});
