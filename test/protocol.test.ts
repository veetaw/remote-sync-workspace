import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net, { AddressInfo } from 'node:net';
import FtpServer from 'ftp-srv';
import { FtpAdapter, SftpAdapter, ConnectionManager } from '../src/adapters';
import { Connection, RemoteAdapter } from '../src/types';
import { sftpServer } from './sftp-server';
import { SyncEngine } from '../src/engine';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
const config = (root: string, port: number): Connection => ({
  id: 'test-protocol',
  name: 'Loopback',
  protocol: 'ftp',
  host: '127.0.0.1',
  port,
  username: 'tester',
  remoteRoot: '/site',
  localRoot: path.join(root, 'workspace'),
  autoUpload: true,
  remotePollingMinutes: 0,
  lazyLoading: true,
  excludes: [],
  timeout: 2000,
  retryAttempts: 0,
  confirmMassDelete: false,
  confirmRename: false,
});
const quiet = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return this;
  },
};

describe('real loopback protocol integrations (no user servers)', () => {
  async function exercise(adapter: RemoteAdapter, root: string): Promise<void> {
    await adapter.connect();
    try {
      await adapter.mkdir('/site/new');
      const local = path.join(root, 'source.bin');
      const bytes = Buffer.from([0, 255, 10, 23]);
      await fs.writeFile(local, bytes);
      await adapter.upload(local, '/site/new/file.bin');
      expect((await adapter.list('/site/new'))[0].name).toBe('file.bin');
      const downloaded = path.join(root, 'received.bin');
      await adapter.download('/site/new/file.bin', downloaded);
      expect(await fs.readFile(downloaded)).toEqual(bytes);
      await adapter.rename('/site/new/file.bin', '/site/new/moved.bin');
      await adapter.deleteFile('/site/new/moved.bin');
      await adapter.deleteDirectory('/site/new');
      await expect(adapter.list('/site/missing')).rejects.toThrow();
    } finally {
      await adapter.disconnect();
    }
  }
  it('FTP connects, transfers binary, lists, renames, deletes and rejects bad credentials', async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), 'rsw-ftp-'),
    );
    await fs.mkdir(path.join(root, 'site'));
    const port = await freePort();
    const server = new FtpServer({
      url: `ftp://127.0.0.1:${port}`,
      anonymous: false,
      pasv_url: '127.0.0.1',
      log: quiet,
    });
    server.on('login', ({ username, password }, resolve, reject) =>
      username === 'tester' && password === 'test-password'
        ? resolve({ root })
        : reject(new Error('Authentication failed')),
    );
    await server.listen();
    try {
      await exercise(
        new FtpAdapter(config(root, port), { password: 'test-password' }),
        root,
      );
      const bad = new FtpAdapter(config(root, port), { password: 'wrong' });
      try {
        await expect(bad.connect()).rejects.toThrow();
      } finally {
        await bad.disconnect();
      }
    } finally {
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('FTPS fails closed on untrusted TLS certificates', async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), 'rsw-ftps-'),
    );
    await fs.mkdir(path.join(root, 'site'));
    const key = path.resolve('test/fixtures/test-key.pem'),
      cert = path.resolve('test/fixtures/test-cert.pem');
    const port = await freePort();
    const server = new FtpServer({
      url: `ftp://127.0.0.1:${port}`,
      log: quiet,
      tls: { key: await fs.readFile(key), cert: await fs.readFile(cert) },
    });
    server.on('login', (_data, resolve) => resolve({ root }));
    await server.listen();
    const adapter = new FtpAdapter(
      { ...config(root, port), protocol: 'ftps' },
      { password: 'test-password' },
    );
    try {
      await expect(adapter.connect()).rejects.toThrow();
      await exercise(
        new FtpAdapter(
          { ...config(root, port), protocol: 'ftps', caFile: cert },
          { password: 'test-password' },
        ),
        root,
      );
    } finally {
      await adapter.disconnect();
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('SFTP verifies host keys, transfers binary and rejects mismatches / bad credentials', async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), 'rsw-sftp-'),
    );
    await fs.mkdir(path.join(root, 'site'));
    const server = await sftpServer(root);
    const c = {
      ...config(root, server.port),
      protocol: 'sftp' as const,
      hostKey: server.fingerprint,
    };
    try {
      await exercise(new SftpAdapter(c, { password: 'test-password' }), root);
      for (const [hostKey, password] of [
        ['0'.repeat(64), 'test-password'],
        [server.fingerprint, 'wrong'],
      ]) {
        const bad = new SftpAdapter({ ...c, hostKey }, { password });
        try {
          await expect(bad.connect()).rejects.toThrow();
        } finally {
          await bad.disconnect().catch(() => {});
        }
      }
    } finally {
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('full FTP SyncEngine publishes saved local content and detects remote conflict', async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), 'rsw-ftp-engine-'),
    );
    await fs.mkdir(path.join(root, 'site'));
    await fs.writeFile(path.join(root, 'site/index.php'), '<?php echo 1;');
    const port = await freePort();
    const server = new FtpServer({
      url: `ftp://127.0.0.1:${port}`,
      log: quiet,
      pasv_url: '127.0.0.1',
    });
    server.on('login', (_data, resolve) => resolve({ root }));
    await server.listen();
    const c = config(root, port);
    const engine = new SyncEngine(
      c,
      path.join(root, 'state'),
      new ConnectionManager(
        () => new FtpAdapter(c, { password: 'test-password' }),
        0,
      ),
      {
        dirty: () => false,
        changed() {},
        report() {},
        confirm: async () => true,
      },
    );
    try {
      await engine.open();
      await engine.sync();
      await fs.writeFile(path.join(c.localRoot, 'index.php'), '<?php echo 2;');
      await engine.localChange('index.php');
      expect(await fs.readFile(path.join(root, 'site/index.php'), 'utf8')).toBe(
        '<?php echo 2;',
      );
      await fs.writeFile(path.join(c.localRoot, 'index.php'), 'local');
      await fs.writeFile(path.join(root, 'site/index.php'), 'remote');
      await engine.sync();
      expect(engine.store.state.files['index.php'].state).toBe('CONFLICT');
    } finally {
      await engine.close();
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('connection timeout is bounded for a server that accepts but never greets', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const adapter = new FtpAdapter(
      { ...config('unused', port), timeout: 150 },
      {},
    );
    try {
      await expect(adapter.connect()).rejects.toThrow();
    } finally {
      await adapter.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
