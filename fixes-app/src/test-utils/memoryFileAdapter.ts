import { utf8Encode } from '../core/crypto/encoding';
import { FileAccessError, type FileAdapter, type PickedFile } from '../core/platform';

export interface SharedFile {
  name: string;
  contents: string;
  mimeType: string;
}

/** FileAdapter for tests: records shared files and returns whatever the test queued for the picker. */
export class MemoryFileAdapter implements FileAdapter {
  readonly shared: SharedFile[] = [];
  /** What the next pickFile() returns: a file, null (cancelled) or an error to throw. */
  nextPick: PickedFile | null | Error = null;
  sharingAvailable = true;

  async shareFile(file: { name: string; contents: string; mimeType: string }): Promise<void> {
    if (!this.sharingAvailable) throw new FileAccessError('sharing_unavailable', 'Sharing is not available');
    this.shared.push({ name: file.name, contents: file.contents, mimeType: file.mimeType });
  }

  async pickFile(options: { maxBytes: number }): Promise<PickedFile | null> {
    const next = this.nextPick;
    if (next instanceof Error) throw next;
    if (next && utf8Encode(next.contents).length > options.maxBytes) {
      throw new FileAccessError('too_large', 'The file is too large');
    }
    return next;
  }
}
