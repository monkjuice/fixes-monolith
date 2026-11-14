import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { FileAccessError, type FileAdapter, type PickedFile } from '../core/platform';

/** iOS needs a UTI for the share sheet; a backup is opaque data. */
const BACKUP_UTI = 'public.data';

function deleteQuietly(file: File, what: string): void {
  try {
    if (file.exists) file.delete();
  } catch (error) {
    // The cache directory is purged by the OS eventually; a leftover copy only holds ciphertext.
    console.warn(`Could not delete the cached ${what}`, error);
  }
}

/**
 * FileAdapter over expo-file-system (File/Paths API), expo-sharing and expo-document-picker
 * (protocol §10): backups are written to the cache directory, handed to the share sheet and deleted
 * afterwards; imports are picked with type `*\/*`, copied to the cache, read and deleted.
 */
export const expoFileAdapter: FileAdapter = {
  async shareFile({ name, contents, mimeType, dialogTitle }) {
    if (!(await Sharing.isAvailableAsync())) {
      throw new FileAccessError('sharing_unavailable', 'Sharing is not available on this device');
    }
    const file = new File(Paths.cache, name);
    try {
      file.create({ overwrite: true });
      file.write(contents);
      await Sharing.shareAsync(file.uri, { mimeType, dialogTitle, UTI: BACKUP_UTI });
    } finally {
      deleteQuietly(file, 'backup file');
    }
  },

  async pickFile({ maxBytes }): Promise<PickedFile | null> {
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset) return null;
    const file = new File(asset.uri);
    try {
      const size = typeof asset.size === 'number' ? asset.size : file.size;
      if (size > maxBytes) throw new FileAccessError('too_large', 'The file is too large');
      let contents: string;
      try {
        contents = await file.text();
      } catch (cause) {
        throw new FileAccessError('unreadable', 'The file could not be read', { cause });
      }
      return { name: asset.name, contents };
    } finally {
      deleteQuietly(file, 'imported file');
    }
  },
};
