import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { AVATAR_JPEG_QUALITY, avatarPlan } from '../presentation/avatarImage';

export type AvatarSource = 'camera' | 'library';

export type AvatarPickErrorCode = 'permission_denied' | 'unavailable' | 'processing_failed';

export class AvatarPickError extends Error {
  readonly code: AvatarPickErrorCode;
  /** permission_denied: false once the OS stops asking (the user must use the system settings). */
  readonly canAskAgain: boolean;

  constructor(code: AvatarPickErrorCode, message: string, options: { canAskAgain?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'AvatarPickError';
    this.code = code;
    this.canAskAgain = options.canAskAgain ?? true;
  }
}

/** A square JPEG of at most 1024 px in the cache directory, ready for `PUT /v1/users/me/avatar`. */
export interface PreparedAvatar {
  uri: string;
  width: number;
  height: number;
}

const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: 'images',
  // The system editor offers the square crop (iOS always crops square; `aspect` is for Android).
  allowsEditing: true,
  aspect: [1, 1],
  // Full quality here: the one lossy step is the final JPEG 0.8 encode.
  quality: 1,
  exif: false,
  base64: false,
};

/**
 * Legacy EditProfile "Camera" / "Choose from library" (§14). Only the camera needs a permission: the
 * system photo pickers on current iOS and Android run outside the app. Null when the user cancels.
 */
export async function pickAvatar(source: AvatarSource): Promise<PreparedAvatar | null> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      throw new AvatarPickError('permission_denied', 'Fixes is not allowed to use the camera.', {
        canAskAgain: permission.canAskAgain,
      });
    }
  }
  let result: ImagePicker.ImagePickerResult;
  try {
    result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync(PICKER_OPTIONS)
        : await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS);
  } catch (cause) {
    // E.g. a simulator without a camera, or no gallery app on the device.
    throw new AvatarPickError('unavailable', ':( No images library available.', { cause });
  }
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return prepareAvatar(asset.uri, asset.width, asset.height);
}

/** §14: square crop, resize to ≤ 1024 px, JPEG quality 0.8 (also strips the original's metadata). */
export async function prepareAvatar(uri: string, width: number, height: number): Promise<PreparedAvatar> {
  let plan;
  try {
    plan = avatarPlan(width, height);
  } catch (cause) {
    throw new AvatarPickError('processing_failed', 'This image could not be read. Choose another photo.', { cause });
  }
  const context = ImageManipulator.manipulate(uri);
  try {
    if (plan.crop) context.crop(plan.crop);
    if (plan.resizeTo !== null) context.resize({ width: plan.resizeTo, height: plan.resizeTo });
    const image = await context.renderAsync();
    try {
      const saved = await image.saveAsync({ compress: AVATAR_JPEG_QUALITY, format: SaveFormat.JPEG });
      return { uri: saved.uri, width: saved.width, height: saved.height };
    } finally {
      image.release();
    }
  } catch (cause) {
    throw new AvatarPickError('processing_failed', 'This image could not be read. Choose another photo.', { cause });
  } finally {
    context.release();
  }
}
