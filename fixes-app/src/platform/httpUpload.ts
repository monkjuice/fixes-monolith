import { File } from 'expo-file-system';

import type { HttpUpload } from '../core/platform';

/**
 * Multipart upload through the global fetch, which Expo replaces with expo/fetch on iOS and Android.
 * expo/fetch encodes a FormData part from a string, a Blob or an object with `bytes()`, never React
 * Native's `{uri}` file part, so the file is read through expo-file-system (the avatar is a JPEG of
 * at most 1024 px); the part keeps the request's file name and type.
 */
export const nativeHttpUpload: HttpUpload = {
  async send(request) {
    const form = new FormData();
    const { uri, name, type } = request.file;
    const part = { name, type, bytes: () => new File(uri).bytes() };
    // Expo's FormData accepts this object shape; the DOM typings only know Blob/string.
    form.append(request.field, part as unknown as Blob);
    return fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: form,
      signal: request.signal,
    });
  },
};
