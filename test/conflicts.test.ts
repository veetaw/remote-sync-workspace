import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeCandidate } from '../src/conflicts';

it('creates a real three way merge candidate without touching inputs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsw-merge-'));
  try {
    const local = path.join(root, 'local'),
      base = path.join(root, 'base'),
      remote = path.join(root, 'remote'),
      output = path.join(root, 'candidate');
    await fs.writeFile(base, 'one\ntwo\nthree\n');
    await fs.writeFile(local, 'LOCAL\ntwo\nthree\n');
    await fs.writeFile(remote, 'one\ntwo\nREMOTE\n');
    await mergeCandidate(local, base, remote, output);
    expect(await fs.readFile(output, 'utf8')).toBe('LOCAL\ntwo\nREMOTE\n');
    expect(await fs.readFile(local, 'utf8')).toBe('LOCAL\ntwo\nthree\n');
    await fs.writeFile(remote, 'OTHER\ntwo\nthree\n');
    await mergeCandidate(local, base, remote, output);
    expect(await fs.readFile(output, 'utf8')).toContain('<<<<<<< Local');
    expect(await fs.readFile(output, 'utf8')).toContain('||||||| Baseline');
    await fs.writeFile(local, Buffer.from([0, 1, 2]));
    await expect(mergeCandidate(local, base, remote, output)).rejects.toThrow(
      'Binary',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
