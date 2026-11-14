import { useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useFixes, useSession } from '../../../hooks';
import { Avatar, Button, InlineError, useToast } from '../../components';
import { AvatarPickError, pickAvatar, type AvatarSource, type PreparedAvatar } from '../../media/avatarPicker';
import type { RootScreenProps } from '../../navigation/types';
import { describeError, GENERIC_ERROR, type ErrorMessages } from '../../presentation/errors';
import { colors, spacing, typography } from '../../theme';

/** Legacy EditProfileViewModel text for a failed upload. */
export const UPLOAD_FAILED = 'Error uploading image, please try again later';

const UPLOAD_ERRORS: ErrorMessages = {
  invalid_image: 'This image could not be used. Choose another photo.',
  payload_too_large: 'This photo is too large. Choose another photo.',
};

const PREVIEW_SIZE = 140;

/**
 * Legacy EditProfile (§14): "Choose from library" / "Camera", a round preview, then Save. The image is
 * square-cropped and resized to ≤ 1024 px JPEG 0.8 right after picking, so the preview is exactly
 * what Save uploads (`PUT /v1/users/me/avatar`).
 */
export function EditProfileScreen({ navigation }: RootScreenProps<'EditProfile'>) {
  const { session } = useFixes();
  const { user } = useSession();
  const showToast = useToast();
  const [preview, setPreview] = useState<PreparedAvatar | null>(null);
  const [picking, setPicking] = useState<AvatarSource | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsHint, setSettingsHint] = useState(false);

  const pick = async (source: AvatarSource) => {
    if (picking || saving) return;
    setPicking(source);
    setError(null);
    setSettingsHint(false);
    try {
      const picked = await pickAvatar(source);
      if (picked) setPreview(picked);
    } catch (caught) {
      if (caught instanceof AvatarPickError) {
        const blocked = caught.code === 'permission_denied' && !caught.canAskAgain;
        setError(blocked ? `${caught.message} You can allow it in the system settings.` : caught.message);
        setSettingsHint(blocked);
      } else {
        console.error('Picking a profile photo failed', caught);
        setError(GENERIC_ERROR);
      }
    } finally {
      setPicking(null);
    }
  };

  const save = async () => {
    if (!preview || saving) return;
    setSaving(true);
    setError(null);
    let user;
    try {
      ({ user } = await session.api.uploadAvatar(preview.uri));
    } catch (caught) {
      const text = describeError(caught, UPLOAD_ERRORS);
      setError(text === GENERIC_ERROR ? UPLOAD_FAILED : text);
      setSaving(false);
      return;
    }
    // The server stored the photo under a new URL and deleted the old one: the session's copy of the
    // account (shown here as the current photo) must follow.
    session.updateUser(user).catch((caught: unknown) => console.warn('Could not update the profile in the session', caught));
    setSaving(false);
    showToast('Profile photo updated');
    navigation.goBack();
  };

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.center}>
        <Avatar uri={preview?.uri ?? user?.avatar_url} size={PREVIEW_SIZE} testID="edit-profile-preview" />
        <Text style={styles.caption}>{preview ? 'New profile photo' : 'Current profile photo'}</Text>
      </View>

      {preview ? (
        <>
          <Button title={saving ? 'Saving..' : 'Save'} onPress={() => void save()} busy={saving} testID="edit-profile-save" />
          <Button title="Choose another photo" variant="link" onPress={() => setPreview(null)} disabled={saving} />
        </>
      ) : (
        <>
          <Button
            title={picking === 'library' ? 'Opening..' : 'Choose from library'}
            variant="secondary"
            onPress={() => void pick('library')}
            busy={picking === 'library'}
            disabled={picking !== null}
            testID="edit-profile-library"
          />
          <Button
            title={picking === 'camera' ? 'Opening..' : 'Camera'}
            variant="secondary"
            onPress={() => void pick('camera')}
            busy={picking === 'camera'}
            disabled={picking !== null}
            testID="edit-profile-camera"
          />
        </>
      )}
      <InlineError message={error} testID="edit-profile-error" />
      {settingsHint ? (
        <Button
          title="Open settings"
          variant="link"
          onPress={() => {
            Linking.openSettings().catch((caught: unknown) => console.warn('Could not open the system settings', caught));
          }}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.white },
  content: { padding: spacing.xl, gap: spacing.md },
  center: { alignItems: 'center', gap: spacing.sm, marginBottom: spacing.lg },
  caption: { ...typography.caption },
});
