import { StyleSheet, Text, View } from 'react-native';

import { Button, Icon } from '../../components';
import type { DeviceView } from '../../presentation/devices';
import { colors, spacing, statusColors } from '../../theme';

export interface DeviceRowProps {
  view: DeviceView;
  removing: boolean;
  disabled: boolean;
  onRemove(): void;
  onLink(): void;
}

/** One device: name, "This device" / "Linked" / "Not linked", last seen, Remove (not for this device). */
export function DeviceRow({ view, removing, disabled, onRemove, onLink }: DeviceRowProps) {
  const { device } = view;
  const statusColor = view.current || view.linked ? colors.text : statusColors.failed;
  return (
    <View style={styles.row} testID={`device-${device.id}`}>
      <Icon name={view.linked ? 'phone-portrait-outline' : 'phone-portrait'} size={28} color={view.linked ? colors.text : colors.textMuted} />
      <View style={styles.text} accessible accessibilityLabel={`${device.name}, ${view.status}${view.isNew ? ', new' : ''}, ${view.lastSeen}`}>
        <View style={styles.titleLine}>
          <Text style={styles.name} numberOfLines={1}>
            {device.name}
          </Text>
          {view.isNew ? <Text style={styles.newTag}>NEW</Text> : null}
        </View>
        <Text style={[styles.status, { color: statusColor }]} testID={`device-status-${device.id}`}>
          {view.status}
        </Text>
        <Text style={styles.seen}>{view.lastSeen}</Text>
      </View>
      {view.current ? null : (
        <View style={styles.actions}>
          {view.linked ? null : (
            <Button title="Link" variant="secondary" onPress={onLink} disabled={disabled} style={styles.small} />
          )}
          <Button
            title={removing ? 'Removing..' : 'Remove'}
            variant="danger"
            onPress={onRemove}
            busy={removing}
            disabled={disabled}
            accessibilityLabel={`Remove ${device.name}`}
            style={styles.small}
            testID={`device-remove-${device.id}`}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  text: { flex: 1, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { fontSize: 16, fontWeight: '700', color: colors.text, flexShrink: 1 },
  newTag: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.white,
    backgroundColor: colors.warningBorder,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
  status: { fontSize: 14 },
  seen: { fontSize: 13, color: colors.textMuted },
  actions: { gap: spacing.xs },
  small: { paddingHorizontal: spacing.md },
});
