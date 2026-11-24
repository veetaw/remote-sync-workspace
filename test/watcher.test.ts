import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers';
import { LocalWatcher } from '../src/watcher';

it('real chokidar coalesces external writes and excludes extension control files', async () => {
  const f = await fixture();
  const errors: unknown[] = [];
  const watcher = new LocalWatcher(f.engine, (e) => errors.push(e));
  try {
    await f.engine.sync();
    watcher.start();
    await new Promise((r) => setTimeout(r, 300));
    await fs.writeFile(path.join(f.local, 'external.php'), 'partial');
    await fs.writeFile(path.join(f.local, 'external.php'), 'complete');
    await fs.writeFile(path.join(f.local, '.remote-sync-internal'), 'private');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && f.remote.uploads === 0)
      await new Promise((r) => setTimeout(r, 100));
    await f.engine.serial.idle();
    expect(errors).toEqual([]);
    expect(f.remote.uploads).toBe(1);
    expect(
      await fs.readFile(path.join(f.remote.root, 'external.php'), 'utf8'),
    ).toBe('complete');
    await expect(
      fs.access(path.join(f.remote.root, '.remote-sync-internal')),
    ).rejects.toThrow();
  } finally {
    await watcher.close();
    await f.engine.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
