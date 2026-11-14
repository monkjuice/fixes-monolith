import fs from 'node:fs/promises';

import type { HttpUpload } from '../core/platform';

/**
 * HttpUpload for Node (e2e): reads the file at `file.uri` (a filesystem path) and sends it as a
 * multipart part with Node's built-in fetch/FormData/Blob.
 */
export const fetchUpload: HttpUpload = {
  async send(request) {
    const bytes = await fs.readFile(request.file.uri);
    const form = new FormData();
    form.append(request.field, new Blob([bytes], { type: request.file.type }), request.file.name);
    return fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: form,
      signal: request.signal,
    });
  },
};
