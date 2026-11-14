/** §14: avatars are square-cropped and at most this many pixels per side before upload. */
export const AVATAR_MAX_SIDE = 1024;
/** §14: JPEG quality 0.8. */
export const AVATAR_JPEG_QUALITY = 0.8;

export interface CropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export interface AvatarPlan {
  /** Centred square crop; null when the picked image is already square (the picker's own crop). */
  crop: CropRect | null;
  /** Target side length; null when the square is already small enough. */
  resizeTo: number | null;
}

/**
 * What to do with a picked image of `width` × `height` pixels. The pickers' "square" editing is not
 * guaranteed on every platform (Android may ignore the aspect, some gallery apps skip editing), so the
 * crop is enforced here; upscaling is never done.
 */
export function avatarPlan(width: number, height: number): AvatarPlan {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new RangeError('The picked image has no size');
  }
  const w = Math.floor(width);
  const h = Math.floor(height);
  const side = Math.min(w, h);
  const crop = w === h ? null : { originX: Math.floor((w - side) / 2), originY: Math.floor((h - side) / 2), width: side, height: side };
  return { crop, resizeTo: side > AVATAR_MAX_SIDE ? AVATAR_MAX_SIDE : null };
}
