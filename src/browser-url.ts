import { relativePath } from './safety';
import { SyncError } from './types';

export function browserBaseUrl(value: string): URL {
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    throw new SyncError(
      'SAFETY',
      'Enter a complete URL, for example https://example.com/',
    );
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    !base.hostname ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new SyncError(
      'SAFETY',
      'The base URL must use HTTP/HTTPS without credentials, a query, or a fragment.',
    );
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return base;
}
export function browserFileUrl(
  baseUrl: string,
  webRoot: string,
  file: string,
): string {
  const base = browserBaseUrl(baseUrl);
  relativePath(file);
  relativePath(webRoot, true);
  if (webRoot && !file.startsWith(`${webRoot}/`))
    throw new SyncError(
      'SAFETY',
      'This file is outside the configured web document root.',
    );
  const relative = webRoot ? file.slice(webRoot.length + 1) : file;
  // Encode each filename component, so #, %, spaces and Unicode remain part of the path.
  return new URL(relative.split('/').map(encodeURIComponent).join('/'), base)
    .href;
}
