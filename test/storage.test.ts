import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, Serial, atomicWrite } from '../src/storage';
import { relativePath, remotePath, localPath } from '../src/safety';
import { ConnectionManager } from '../src/adapters';
import { DiskRemote } from './helpers';

describe('storage and safety', () => {
  it('writes durable state and fails closed on corruption', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsw-store-'));
    try {
      const store = new Store(dir);
      await store.open('identity');
      await atomicWrite(path.join(dir, 'state.json'), '{bad');
      await expect(new Store(dir).open('identity')).rejects.toThrow(
        'Unreadable',
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it.each([
    '../a',
    '/etc/passwd',
    'a/../b',
    'a\\b',
    'a//b',
    'NUL.php',
    'a:stream',
    'a.',
  ])('rejects unsafe path %s', (p) => {
    expect(() => relativePath(p)).toThrow();
  });
  it('uses exact remote root boundaries', () => {
    expect(remotePath('/var/www', 'index.php')).toBe('/var/www/index.php');
    expect(() => remotePath('/var/../outside', 'a')).toThrow();
  });
  it('rejects local symlinks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsw-link-'));
    try {
      await fs.symlink(os.tmpdir(), path.join(dir, 'alias'), 'junction');
      await expect(localPath(dir, 'alias/outside')).rejects.toThrow('Symlinks');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it('serializes dependent jobs even after an error', async () => {
    const serial = new Serial();
    const order: number[] = [];
    await Promise.allSettled([
      serial.run(async () => {
        order.push(1);
        throw new Error('fail');
      }),
      serial.run(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
  it('reconnects without losing queued state', async () => {
    const adapter = new DiskRemote('unused');
    const manager = new ConnectionManager(() => adapter, 0);
    await manager.get();
    await manager.invalidate();
    await manager.get();
    expect(adapter.connects).toBe(2);
  });
  it('bounded authentication/timeout failure remains offline', async () => {
    const adapter = new DiskRemote('unused');
    adapter.failConnect = true;
    const manager = new ConnectionManager(() => adapter, 1);
    await expect(manager.get()).rejects.toThrow();
    expect(adapter.connects).toBe(2);
    expect(manager.status).toBe('OFFLINE');
  });
});
