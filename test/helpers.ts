import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  RemoteAdapter,
  RemoteEntry,
  Connection,
  TransferContext,
  cancelled,
} from '../src/types';
import { ConnectionManager } from '../src/adapters';
import { SyncEngine } from '../src/engine';

export class DiskRemote implements RemoteAdapter {
  readonly capabilities = {
    streams: true,
    atomicUpload: false as const,
    hash: false as const,
  };
  uploads = 0;
  connects = 0;
  failConnect = false;
  failList = false;
  failDownload = false;
  failUpload = false;
  corruptUpload = false;
  duringUpload?: () => Promise<void>;
  constructor(readonly root: string) {}
  file(p: string): string {
    if (!p.startsWith('/site')) throw new Error('Outside remote root');
    return path.join(this.root, p.slice(5));
  }
  async connect(): Promise<void> {
    this.connects++;
    if (this.failConnect) throw new Error('Credentials or timeout');
  }
  async disconnect(): Promise<void> {}
  async list(p: string, context?: TransferContext): Promise<RemoteEntry[]> {
    cancelled(context?.signal);
    if (this.failList) throw new Error('Listing failed');
    return Promise.all(
      (await fs.readdir(this.file(p), { withFileTypes: true })).map(
        async (f) => ({
          name: f.name,
          type: f.isSymbolicLink()
            ? ('symlink' as const)
            : f.isDirectory()
              ? ('directory' as const)
              : ('file' as const),
          size: (await fs.lstat(this.file(`${p}/${f.name}`))).size,
        }),
      ),
    );
  }
  async download(
    remote: string,
    local: string,
    context?: TransferContext,
  ): Promise<void> {
    cancelled(context?.signal);
    if (this.failDownload) {
      await fs.writeFile(local, 'partial');
      throw new Error('Interrupted download');
    }
    await fs.copyFile(this.file(remote), local);
  }
  async upload(local: string, remote: string): Promise<void> {
    this.uploads++;
    if (this.failUpload) {
      await fs.writeFile(this.file(remote), 'partial');
      throw new Error('Interrupted upload');
    }
    await fs.copyFile(local, this.file(remote));
    await this.duringUpload?.();
    if (this.corruptUpload) await fs.writeFile(this.file(remote), 'corrupt');
  }
  async mkdir(p: string): Promise<void> {
    await fs.mkdir(this.file(p));
  }
  async rename(from: string, to: string): Promise<void> {
    await fs.rename(this.file(from), this.file(to));
  }
  async deleteFile(p: string): Promise<void> {
    await fs.unlink(this.file(p));
  }
  async deleteDirectory(p: string): Promise<void> {
    await fs.rmdir(this.file(p));
  }
}
export async function fixture(): Promise<{
  root: string;
  local: string;
  remote: DiskRemote;
  engine: SyncEngine;
  config: Connection;
  reports: string[];
  dirty: Set<string>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsw-test-'));
  const local = path.join(root, 'local');
  const remoteDir = path.join(root, 'remote');
  await fs.mkdir(remoteDir);
  const remote = new DiskRemote(remoteDir);
  const config: Connection = {
    id: randomUUID(),
    name: 'Test',
    protocol: 'ftp',
    host: '127.0.0.1',
    port: 21,
    username: 'test',
    remoteRoot: '/site',
    localRoot: local,
    autoUpload: true,
    remotePollingMinutes: 0,
    lazyLoading: true,
    excludes: ['**/excluded/**'],
    timeout: 1000,
    retryAttempts: 0,
    confirmMassDelete: true,
    confirmRename: false,
  };
  const reports: string[] = [];
  const dirty = new Set<string>();
  const engine = new SyncEngine(
    config,
    path.join(root, 'state'),
    new ConnectionManager(() => remote, 0),
    {
      dirty: (p) => dirty.has(p),
      report: (m) => reports.push(m),
      confirm: async () => true,
      changed: () => {},
    },
  );
  await engine.open();
  return { root, local, remote, engine, config, reports, dirty };
}
