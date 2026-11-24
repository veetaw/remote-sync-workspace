import path from 'node:path';
import fs from 'node:fs/promises';
import { minimatch } from 'minimatch';
import { SyncError } from './types';

export function relativePath(value: string, rootAllowed = false): string {
  if (value === '' && rootAllowed) return '';
  const segments = value.split('/');
  if (
    !value ||
    value.includes('\\') ||
    segments.some(
      (s) =>
        !s ||
        s === '.' ||
        s === '..' ||
        /[\x00-\x1f<>:"|?*]/.test(s) ||
        /[. ]$/.test(s) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
    )
  ) {
    throw new SyncError('SAFETY', 'Unsafe or non-portable path');
  }
  return value;
}
export function remotePath(root: string, value: string): string {
  relativePath(value, true);
  if (
    !root.startsWith('/') ||
    root.includes('\\') ||
    /[\x00-\x1f]/.test(root) ||
    root.split('/').includes('..')
  )
    throw new SyncError('SAFETY', 'Remote root must be an absolute POSIX path');
  return path.posix.join(root, value);
}
export function excluded(value: string, patterns: string[]): boolean {
  return (
    value
      .split('/')
      .some(
        (s) =>
          s === '.git' ||
          s.startsWith('.remote-sync') ||
          s.startsWith('[DIR] ') ||
          /^\.?#.*#$/.test(s) ||
          /(?:~|\.sw[opx]|\.tmp)$/.test(s),
      ) ||
    patterns.some(
      (p) =>
        minimatch(value, p, { dot: true }) ||
        value.split('/').some((_, i, a) => {
          const part = a.slice(0, i + 1).join('/');
          return (
            minimatch(part, p, { dot: true }) ||
            minimatch(`${part}/`, p, { dot: true })
          );
        }),
    )
  );
}
export async function localPath(root: string, value: string): Promise<string> {
  relativePath(value, true);
  const target = path.resolve(root, value);
  let current = path.resolve(root);
  // Refuse all symlinks, including an aliased workspace root.
  const ancestors: string[] = [];
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const part of [
    ...ancestors.reverse(),
    ...value
      .split('/')
      .filter(Boolean)
      .map((_, i, a) => path.resolve(root, ...a.slice(0, i + 1))),
  ]) {
    try {
      if (
        part !== path.resolve(root) &&
        part.startsWith(path.resolve(root) + path.sep)
      ) {
        const wanted = path.basename(part);
        const names = await fs.readdir(path.dirname(part));
        if (
          names.some(
            (name) =>
              name !== wanted &&
              name.normalize('NFC').toLowerCase() ===
                wanted.normalize('NFC').toLowerCase(),
          )
        )
          throw new SyncError(
            'SAFETY',
            'Local path differs only in case or Unicode normalization',
          );
      }
      if ((await fs.lstat(part)).isSymbolicLink())
        throw new SyncError('SAFETY', 'Symlinks are not synchronized');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}
export function identity(c: {
  protocol: string;
  host: string;
  port: number;
  username: string;
  remoteRoot: string;
  localRoot: string;
}): string {
  return JSON.stringify([
    c.protocol,
    c.host,
    c.port,
    c.username,
    c.remoteRoot,
    path.resolve(c.localRoot),
  ]);
}
