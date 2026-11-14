import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';

import { FileAccessError } from '../../core/platform';
import { expoFileAdapter } from '../fileAdapter';

interface MockFileRecord {
  uri: string;
  contents: string | null;
  deleted: boolean;
  size: number;
}

const mockFiles = new Map<string, MockFileRecord>();

jest.mock('expo-file-system', () => {
  class File {
    readonly uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
      if (!mockFiles.has(this.uri)) mockFiles.set(this.uri, { uri: this.uri, contents: null, deleted: false, size: 0 });
    }
    private get record() {
      return mockFiles.get(this.uri)!;
    }
    get exists() {
      return this.record.contents !== null && !this.record.deleted;
    }
    get size() {
      return this.record.size;
    }
    create() {
      this.record.contents = '';
    }
    write(contents: string) {
      this.record.contents = contents;
      this.record.size = contents.length;
    }
    async text() {
      if (this.record.contents === null) throw new Error('missing');
      return this.record.contents;
    }
    delete() {
      this.record.deleted = true;
    }
  }
  return { File, Paths: { cache: { uri: 'file:///cache' } } };
});

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

const share = Sharing.shareAsync as jest.Mock;
const available = Sharing.isAvailableAsync as jest.Mock;
const pick = DocumentPicker.getDocumentAsync as jest.Mock;

beforeEach(() => {
  mockFiles.clear();
  jest.clearAllMocks();
});

describe('expoFileAdapter', () => {
  it('writes the backup to the cache, opens the share sheet and deletes the copy', async () => {
    let contentsWhenShared: string | null = null;
    share.mockImplementation(async (uri: string) => {
      contentsWhenShared = mockFiles.get(uri)?.contents ?? null;
    });
    await expoFileAdapter.shareFile({ name: 'fixes-backup-a-20261113-0900.fixes', contents: '{"x":1}', mimeType: 'application/octet-stream' });
    const uri = 'file:///cache/fixes-backup-a-20261113-0900.fixes';
    expect(share).toHaveBeenCalledWith(uri, expect.objectContaining({ mimeType: 'application/octet-stream', UTI: 'public.data' }));
    expect(contentsWhenShared).toBe('{"x":1}');
    expect(mockFiles.get(uri)?.deleted).toBe(true);
  });

  it('deletes the cache copy even when sharing fails, and reports a missing share sheet', async () => {
    share.mockRejectedValueOnce(new Error('share failed'));
    await expect(expoFileAdapter.shareFile({ name: 'b.fixes', contents: 'x', mimeType: 'application/octet-stream' })).rejects.toThrow(
      'share failed',
    );
    expect(mockFiles.get('file:///cache/b.fixes')?.deleted).toBe(true);
    available.mockResolvedValueOnce(false);
    await expect(expoFileAdapter.shareFile({ name: 'c.fixes', contents: 'x', mimeType: 'x' })).rejects.toMatchObject({
      code: 'sharing_unavailable',
    });
  });

  it('picks any file type, copies it to the cache, reads it and deletes the copy', async () => {
    const uri = 'file:///cache/DocumentPicker/backup.fixes';
    mockFiles.set(uri, { uri, contents: '{"format":"fixes-backup"}', deleted: false, size: 25 });
    pick.mockResolvedValueOnce({ canceled: false, assets: [{ uri, name: 'backup.fixes', size: 25, lastModified: 0 }] });
    expect(await expoFileAdapter.pickFile({ maxBytes: 1000 })).toEqual({ name: 'backup.fixes', contents: '{"format":"fixes-backup"}' });
    expect(pick).toHaveBeenCalledWith({ type: '*/*', copyToCacheDirectory: true, multiple: false });
    expect(mockFiles.get(uri)?.deleted).toBe(true);
  });

  it('returns null when cancelled and refuses files over the limit', async () => {
    pick.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await expoFileAdapter.pickFile({ maxBytes: 10 })).toBeNull();
    const uri = 'file:///cache/DocumentPicker/huge.bin';
    mockFiles.set(uri, { uri, contents: 'x'.repeat(50), deleted: false, size: 50 });
    pick.mockResolvedValueOnce({ canceled: false, assets: [{ uri, name: 'huge.bin', size: 50, lastModified: 0 }] });
    await expect(expoFileAdapter.pickFile({ maxBytes: 10 })).rejects.toBeInstanceOf(FileAccessError);
    expect(mockFiles.get(uri)?.deleted).toBe(true);
  });
});
