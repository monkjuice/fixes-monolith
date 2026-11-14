import { useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../../core/api/errors';
import { useFixes, useOwnIdentityKey, useSession } from '../../../hooks';
import { Banner, confirm, EmptyState, ErrorState, InlineError, LoadingState, useToast } from '../../components';
import { useApiQuery } from '../../hooks/useApiQuery';
import { useNow } from '../../hooks/useNow';
import { useReloadOnFocus } from '../../hooks/useReloadOnFocus';
import type { RootScreenProps } from '../../navigation/types';
import { deviceViews, type DeviceView } from '../../presentation/devices';
import { describeError } from '../../presentation/errors';
import { colors, spacing, typography } from '../../theme';
import { DeviceRow } from './DeviceRow';

/** §5.4: at most 10 active devices per account. */
const MAX_DEVICES = 10;

const keyExtractor = (view: DeviceView) => view.device.id;

function newDeviceNotice(views: readonly DeviceView[]): string | null {
  const fresh = views.filter((view) => view.isNew);
  if (fresh.length === 0) return null;
  if (fresh.length === 1) {
    return `A new device, "${fresh[0].device.name}", was added to your account after this one. If this wasn't you, remove it and change your password.`;
  }
  return `${fresh.length} new devices were added to your account after this one. If you don't recognise one, remove it and change your password.`;
}

/**
 * §8 / §5.4 Devices: every active device of the account, this one first, with "Not linked" for
 * devices still waiting to be linked (checked here against the AIK this install holds, never the key
 * the server reports), last seen, and removal (revocation) with a confirmation. Devices added after
 * this one are pointed out.
 */
export function DevicesScreen({ navigation }: RootScreenProps<'Devices'>) {
  const { session } = useFixes();
  const { user } = useSession();
  const own = useOwnIdentityKey();
  const showToast = useToast();
  const now = useNow(60_000);
  const [removing, setRemoving] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pulled, setPulled] = useState(false);

  const load = useCallback(async () => (await session.api.listMyDevices()).devices, [session]);
  const devices = useApiQuery(load);
  const reloadDevices = devices.reload;
  useReloadOnFocus(reloadDevices);

  const userId = user?.id ?? null;
  const identityKey = own.publicKey;
  const views = useMemo(
    () => (devices.data && userId ? deviceViews(devices.data, { userId, identityKey }, now) : []),
    [devices.data, userId, identityKey, now],
  );
  const notice = newDeviceNotice(views);

  const remove = useCallback(
    async (view: DeviceView) => {
      const name = view.device.name;
      const confirmed = await confirm({
        title: `Remove "${name}"?`,
        message:
          'It will be signed out of your account and messages not yet delivered to it are deleted. Messages already stored on it stay there.',
        confirmText: 'Remove',
        destructive: true,
      });
      if (!confirmed) return;
      setRemoving(view.device.id);
      setActionError(null);
      setPulled(false);
      try {
        await session.api.revokeDevice(view.device.id);
        showToast(`"${name}" was removed from your account.`);
      } catch (error) {
        // not_found: it was already revoked (elsewhere, or by the idle sweep); the reload shows that.
        if (!(error instanceof ApiError && error.code === 'not_found')) setActionError(describeError(error));
      } finally {
        setRemoving(null);
        reloadDevices();
      }
    },
    [session, showToast, reloadDevices],
  );

  const renderItem = ({ item }: { item: DeviceView }) => (
    <DeviceRow
      view={item}
      removing={removing === item.device.id}
      disabled={removing !== null}
      onRemove={() => void remove(item)}
      onLink={() => navigation.navigate('LinkDevice')}
    />
  );

  if (!devices.data || own.loading) {
    return (
      <View style={styles.page}>
        {devices.error && !devices.data ? (
          <ErrorState message={describeError(devices.error)} onRetry={devices.reload} />
        ) : (
          <LoadingState label="Loading devices" />
        )}
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <FlatList
        data={views}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={
          <View>
            {notice ? (
              <Banner
                tone="warning"
                icon="warning-outline"
                text={notice}
                actions={[{ title: 'Change password', onPress: () => navigation.navigate('ChangePassword') }]}
                testID="devices-new-notice"
              />
            ) : null}
            <InlineError message={actionError} testID="devices-error" />
            {devices.error ? <InlineError message={describeError(devices.error)} /> : null}
            <Text style={styles.intro}>
              Linked devices can read your messages. A device that is not linked cannot, until you link it from here.
            </Text>
          </View>
        }
        ListEmptyComponent={<EmptyState icon="phone-portrait-outline" title="No devices" />}
        ListFooterComponent={<Text style={styles.footer}>{`${views.length} of ${MAX_DEVICES} devices`}</Text>}
        refreshControl={
          <RefreshControl
            refreshing={pulled && devices.loading}
            onRefresh={() => {
              setPulled(true);
              devices.reload();
            }}
            colors={[colors.black]}
            tintColor={colors.black}
          />
        }
        testID="devices-list"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  intro: { ...typography.body, color: colors.textMuted, padding: spacing.lg },
  footer: { ...typography.caption, textAlign: 'center', padding: spacing.lg },
});
