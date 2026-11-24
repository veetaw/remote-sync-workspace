import { relativePath } from './safety';
import { SyncError } from './types';

export function browserBaseUrl(value: string): URL {
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    throw new SyncError(
      'SAFETY',
      'Inserisci un URL completo, per esempio https://example.com/',
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
      'L’URL base deve usare HTTP/HTTPS, senza credenziali, query o frammenti.',
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
      'Questo file è fuori dalla cartella web configurata.',
    );
  const relative = webRoot ? file.slice(webRoot.length + 1) : file;
  // Encode each filename component, so #, %, spaces and Unicode remain part of the path.
  return new URL(relative.split('/').map(encodeURIComponent).join('/'), base)
    .href;
}
