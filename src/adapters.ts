import { Client } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import {
  Connection,
  Credentials,
  RemoteAdapter,
  RemoteEntry,
  TransferContext,
  SyncError,
  cancelled,
} from './types';

abstract class AdapterBase {
  readonly capabilities = {
    streams: true,
    atomicUpload: false as const,
    hash: false as const,
  };
  protected operationTimeout = 30000;
  protected async transfer<T>(
    context: TransferContext | undefined,
    close: () => void,
    work: () => Promise<T>,
  ): Promise<T> {
    cancelled(context?.signal);
    context?.signal?.addEventListener('abort', close, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        close();
        reject(new SyncError('NETWORK', 'Protocol operation timed out'));
      }, this.operationTimeout);
    });
    try {
      const result = await Promise.race([work(), timeout]);
      cancelled(context?.signal);
      return result;
    } finally {
      clearTimeout(timer);
      context?.signal?.removeEventListener('abort', close);
    }
  }
}
export class FtpAdapter extends AdapterBase implements RemoteAdapter {
  private client: Client;
  constructor(
    private config: Connection,
    private credentials: Credentials,
  ) {
    super();
    this.operationTimeout = config.timeout;
    this.client = new Client(config.timeout);
  }
  async connect(): Promise<void> {
    await this.client.access({
      host: this.config.host,
      port: this.config.port,
      user: this.config.username,
      password: this.credentials.password,
      secure: this.config.protocol === 'ftps',
      secureOptions: {
        rejectUnauthorized: true,
        servername: isIP(this.config.host) ? undefined : this.config.host,
        ca: this.config.caFile
          ? await fs.readFile(this.config.caFile)
          : undefined,
      },
    });
  }
  async disconnect(): Promise<void> {
    this.client.close();
  }
  async list(
    remote: string,
    context?: TransferContext,
  ): Promise<RemoteEntry[]> {
    return this.transfer(
      context,
      () => this.client.close(),
      async () =>
        (await this.client.list(remote)).map((f) => ({
          name: f.name,
          type: f.isSymbolicLink
            ? 'symlink'
            : f.isDirectory
              ? 'directory'
              : 'file',
          size: f.size,
          modified: f.modifiedAt?.getTime(),
        })),
    );
  }
  async download(
    remote: string,
    local: string,
    context?: TransferContext,
  ): Promise<void> {
    this.client.trackProgress((info) => context?.progress?.(info.bytesOverall));
    try {
      await this.transfer(
        context,
        () => this.client.close(),
        () => this.client.downloadTo(local, remote),
      );
    } finally {
      this.client.trackProgress();
    }
  }
  async upload(
    local: string,
    remote: string,
    context?: TransferContext,
  ): Promise<void> {
    this.client.trackProgress((info) => context?.progress?.(info.bytesOverall));
    try {
      await this.transfer(
        context,
        () => this.client.close(),
        () => this.client.uploadFrom(local, remote),
      );
    } finally {
      this.client.trackProgress();
    }
  }
  async mkdir(remote: string): Promise<void> {
    await this.client.send(`MKD ${remote}`);
  }
  async rename(from: string, to: string): Promise<void> {
    await this.client.rename(from, to);
  }
  async deleteFile(remote: string): Promise<void> {
    await this.client.remove(remote, false);
  }
  async deleteDirectory(remote: string): Promise<void> {
    await this.client.send(`RMD ${remote}`);
  }
}
export class SftpAdapter extends AdapterBase implements RemoteAdapter {
  private client = new SftpClient();
  constructor(
    private config: Connection,
    private credentials: Credentials,
  ) {
    super();
    this.operationTimeout = config.timeout;
  }
  async connect(): Promise<void> {
    if (!this.config.hostKey || !/^[a-f0-9]{64}$/i.test(this.config.hostKey))
      throw new Error(
        'SFTP requires a trusted SHA-256 host-key fingerprint (64 hex characters), obtained out of band.',
      );
    await this.client.connect({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.credentials.password,
      privateKey: this.config.privateKeyPath
        ? await fs.readFile(this.config.privateKeyPath)
        : undefined,
      passphrase: this.credentials.passphrase,
      readyTimeout: this.config.timeout,
      hostHash: 'sha256',
      hostVerifier: (key: string) =>
        key.toLowerCase() === this.config.hostKey!.toLowerCase(),
      retries: 0,
    });
    // Configured root must itself resolve to its canonical location.
    const actual = await this.client.realPath(this.config.remoteRoot);
    if (
      actual.replace(/\/$/, '') !== this.config.remoteRoot.replace(/\/$/, '')
    ) {
      await this.disconnect();
      throw new Error(
        'Remote root is an alias/symlink; configure its canonical path.',
      );
    }
  }
  async disconnect(): Promise<void> {
    await this.client.end();
  }
  async list(
    remote: string,
    context?: TransferContext,
  ): Promise<RemoteEntry[]> {
    return this.transfer(
      context,
      () => {
        void this.client.end().catch(() => undefined);
      },
      async () =>
        (await this.client.list(remote)).map((f) => ({
          name: f.name,
          type:
            f.type === 'l' ? 'symlink' : f.type === 'd' ? 'directory' : 'file',
          size: f.size,
          modified: f.modifyTime,
        })),
    );
  }
  async download(
    remote: string,
    local: string,
    context?: TransferContext,
  ): Promise<void> {
    await this.transfer(
      context,
      () => {
        void this.client.end().catch(() => undefined);
      },
      async () => {
        await this.client.get(remote, local);
        context?.progress?.((await fs.stat(local)).size);
      },
    );
  }
  async upload(
    local: string,
    remote: string,
    context?: TransferContext,
  ): Promise<void> {
    await this.transfer(
      context,
      () => {
        void this.client.end().catch(() => undefined);
      },
      async () => {
        await this.client.put(local, remote);
        context?.progress?.((await fs.stat(local)).size);
      },
    );
  }
  async mkdir(remote: string): Promise<void> {
    await this.transfer(
      undefined,
      () => {
        void this.client.end().catch(() => undefined);
      },
      () => this.client.mkdir(remote, false),
    );
  }
  async rename(from: string, to: string): Promise<void> {
    await this.transfer(
      undefined,
      () => {
        void this.client.end().catch(() => undefined);
      },
      () => this.client.rename(from, to),
    );
  }
  async deleteFile(remote: string): Promise<void> {
    await this.transfer(
      undefined,
      () => {
        void this.client.end().catch(() => undefined);
      },
      () => this.client.delete(remote, false),
    );
  }
  async deleteDirectory(remote: string): Promise<void> {
    await this.transfer(
      undefined,
      () => {
        void this.client.end().catch(() => undefined);
      },
      () => this.client.rmdir(remote, false),
    );
  }
}
export class ConnectionManager {
  private adapter?: RemoteAdapter;
  status: 'ONLINE' | 'OFFLINE' = 'OFFLINE';
  constructor(
    private factory: () => RemoteAdapter,
    private retries: number,
    private notify: () => void = () => {},
  ) {}
  async get(): Promise<RemoteAdapter> {
    if (this.adapter) return this.adapter;
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const adapter = this.factory();
      try {
        await adapter.connect();
        this.adapter = adapter;
        this.status = 'ONLINE';
        this.notify();
        return adapter;
      } catch (e) {
        last = e;
        await adapter.disconnect().catch(() => undefined);
        const failure = e as {
          code?: string | number;
          level?: string;
          message?: string;
        };
        if (
          failure.code === 530 ||
          failure.level === 'client-authentication' ||
          /host.*(?:denied|key)|verification failed|certificate|self.signed/i.test(
            failure.message ?? '',
          )
        ) {
          this.status = 'OFFLINE';
          this.notify();
          throw new SyncError(
            'SAFETY',
            'Authentication or server identity verification failed. Verify credentials and trusted TLS/SSH identity.',
          );
        }
        if (attempt < this.retries)
          await new Promise((r) =>
            setTimeout(r, Math.min(200 * 2 ** attempt, 2000)),
          );
      }
    }
    this.status = 'OFFLINE';
    this.notify();
    throw last;
  }
  async invalidate(): Promise<void> {
    const adapter = this.adapter;
    this.adapter = undefined;
    this.status = 'OFFLINE';
    await adapter?.disconnect().catch(() => undefined);
    this.notify();
  }
}
