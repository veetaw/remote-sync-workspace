import { it, expect } from 'vitest';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { sftpServer } from './sftp-server';
import { Connection } from '../src/types';

it('bundled SFTP runtime works without optional native accelerators', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsw-bundle-'));
  await fs.mkdir(path.join(root, 'site'));
  const server = await sftpServer(root);
  const bundle = path.join(root, 'adapter.cjs');
  try {
    await build({
      entryPoints: ['src/adapters.ts'],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      outfile: bundle,
      external: ['cpu-features'],
    });
    const module = (await import(
      pathToFileURL(bundle).href
    )) as typeof import('../src/adapters');
    const config: Connection = {
      id: 'bundle',
      name: 'Bundle',
      protocol: 'sftp',
      host: '127.0.0.1',
      port: server.port,
      username: 'tester',
      hostKey: server.fingerprint,
      remoteRoot: '/site',
      localRoot: root,
      autoUpload: true,
      remotePollingMinutes: 0,
      lazyLoading: true,
      excludes: [],
      timeout: 5000,
      retryAttempts: 0,
      confirmRename: false,
      confirmMassDelete: true,
    };
    const adapter = new module.SftpAdapter(config, {
      password: 'test-password',
    });
    try {
      await adapter.connect();
      const source = path.join(root, 'source');
      const bytes = Buffer.alloc(256 * 1024, 213);
      await fs.writeFile(source, bytes);
      await adapter.upload(source, '/site/binary');
      const received = path.join(root, 'received');
      await adapter.download('/site/binary', received);
      expect(await fs.readFile(received)).toEqual(bytes);
    } finally {
      await adapter.disconnect();
    }
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
