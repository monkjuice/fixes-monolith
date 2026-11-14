import { nativeHttpUpload } from '../httpUpload';

// On iOS and Android Expo installs expo/fetch as the global fetch (expo/src/winter/runtime.native.ts).
// This test runs the real expo/fetch, with React Native's FormData patched the way Expo patches it;
// only the native request and response objects are replaced.
const mockNativeStarts: { url: string; init: { method: string; headers: [string, string][] }; body: Uint8Array | null }[] = [];

jest.mock('expo/src/winter/fetch/ExpoFetchModule', () => ({
  ExpoFetchModule: {
    NativeRequest: class {
      async start(url: string, init: never, body: Uint8Array | null) {
        mockNativeStarts.push({ url, init, body });
      }
      cancel() {}
    },
  },
}));

jest.mock('expo/src/winter/fetch/FetchResponse', () => ({
  FetchResponse: class {
    abort() {}
  },
}));

const mockJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

jest.mock('expo-file-system', () => ({
  File: class {
    readonly uri: string;
    constructor(fileUri: string) {
      this.uri = fileUri;
    }
    get name() {
      return 'ImageManipulator-3F2A.jpg';
    }
    get type() {
      return 'application/octet-stream';
    }
    async bytes() {
      if (this.uri !== 'file:///data/cache/ImageManipulator-3F2A.jpg') throw new Error(`No file at ${this.uri}`);
      return mockJpeg;
    }
  },
}));

const originalFetch = globalThis.fetch;
const originalFormData = globalThis.FormData;

beforeAll(() => {
  // React Native's own FormData class, patched as expo/src/winter/runtime.native.ts does.
  const rnFormData = jest.requireActual<{ default?: typeof FormData } & typeof FormData>('react-native/Libraries/Network/FormData');
  const FormDataClass = rnFormData.default ?? rnFormData;
  const { installFormDataPatch } = jest.requireActual<{ installFormDataPatch(formData: typeof FormData): void }>(
    'expo/src/winter/FormData',
  );
  installFormDataPatch(FormDataClass);
  Object.defineProperty(globalThis, 'FormData', { value: FormDataClass, configurable: true, writable: true });
  const { fetch: expoFetch } = jest.requireActual<{ fetch: typeof fetch }>('expo/src/winter/fetch/fetch');
  Object.defineProperty(globalThis, 'fetch', { value: expoFetch, configurable: true, writable: true });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'fetch', { value: originalFetch, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'FormData', { value: originalFormData, configurable: true, writable: true });
});

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

describe('nativeHttpUpload', () => {
  it('sends the avatar as a multipart file part that expo/fetch can encode', async () => {
    await nativeHttpUpload.send({
      url: 'https://api.fixes.test/v1/users/me/avatar',
      method: 'PUT',
      headers: { Accept: 'application/json', Authorization: 'Bearer token' },
      field: 'image',
      file: { uri: 'file:///data/cache/ImageManipulator-3F2A.jpg', name: 'avatar.jpg', type: 'image/jpeg' },
      signal: new AbortController().signal,
    });

    expect(mockNativeStarts).toHaveLength(1);
    const { url, init, body } = mockNativeStarts[0];
    expect(url).toBe('https://api.fixes.test/v1/users/me/avatar');
    expect(init.method).toBe('PUT');
    const headers = Object.fromEntries(init.headers.map(([k, v]) => [k.toLowerCase(), v]));
    expect(headers.authorization).toBe('Bearer token');
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(headers['content-type'])?.[1];
    expect(boundary).toBeDefined();

    const text = Buffer.from(body!).toString('latin1');
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text).toContain('content-disposition: form-data; name="image"; filename="avatar.jpg"\r\n');
    expect(text).toContain('content-type: image/jpeg\r\n');
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
    // The file's bytes, right after the part headers.
    expect(indexOfBytes(body!, mockJpeg)).toBe(text.indexOf('\r\n\r\n') + 4);
  });
});
