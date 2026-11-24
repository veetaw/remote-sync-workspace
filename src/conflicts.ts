import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SyncError } from './types';

const exec = promisify(execFile);
export async function mergeCandidate(
  local: string,
  base: string,
  remote: string,
  output: string,
): Promise<void> {
  for (const file of [local, base, remote]) {
    if ((await fs.stat(file)).size > 16 * 1024 * 1024)
      throw new SyncError(
        'SAFETY',
        'Text merge is limited to 16 MiB per version; use external tools for larger files',
      );
    if ((await fs.readFile(file)).includes(0))
      throw new SyncError(
        'SAFETY',
        'Binary content requires explicit Keep Local / Keep Remote selection',
      );
  }
  let merged: Buffer;
  try {
    merged = (
      await exec(
        'git',
        [
          'merge-file',
          '-p',
          '--diff3',
          '-L',
          'Local',
          '-L',
          'Baseline',
          '-L',
          'Remote',
          local,
          base,
          remote,
        ],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      )
    ).stdout;
  } catch (e) {
    const error = e as { code?: number; stdout?: Buffer };
    if (
      typeof error.code !== 'number' ||
      error.code < 1 ||
      error.code > 127 ||
      !error.stdout
    )
      throw e;
    merged = error.stdout;
  }
  await fs.writeFile(output, merged, { mode: 0o600 });
}
