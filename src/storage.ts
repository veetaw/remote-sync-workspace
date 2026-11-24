import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { State, SyncError } from './types';

export async function hashFile(file: string): Promise<string | null> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export async function atomicWrite(
  file: string,
  data: string | Buffer,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  // fsync directory where supported. Windows does not allow directory fsync.
  if (process.platform !== 'win32') {
    const dir = await fs.open(path.dirname(file), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
export class Store {
  state!: State;
  constructor(readonly directory: string) {}
  async open(binding: string): Promise<void> {
    await fs.mkdir(path.join(this.directory, 'blobs'), { recursive: true });
    try {
      this.state = JSON.parse(
        await fs.readFile(path.join(this.directory, 'state.json'), 'utf8'),
      ) as State;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new SyncError(
          'SAFETY',
          'Unreadable state; automatic synchronization blocked. Preserve state and inspect diagnostics.',
        );
      this.state = {
        schema: 1,
        identity: binding,
        files: {},
        directories: { '': 'DISCOVERED' },
        operations: [],
      };
    }
    if (this.state.schema !== 1 || this.state.identity !== binding)
      throw new SyncError(
        'SAFETY',
        'Workspace binding changed; use a new connection/local directory.',
      );
    for (const op of this.state.operations)
      if (op.state === 'RUNNING') {
        op.state = 'UNCERTAIN';
        op.error = 'Interrupted operation: remote reconciliation required';
      }
    for (const dir in this.state.directories)
      if (this.state.directories[dir] === 'LOADING')
        this.state.directories[dir] = 'ERROR';
    await this.save();
  }
  async save(): Promise<void> {
    await atomicWrite(
      path.join(this.directory, 'state.json'),
      JSON.stringify(this.state, null, 2),
    );
  }
  blob(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid content hash');
    return path.join(this.directory, 'blobs', hash);
  }
  async verifiedBlob(hash: string): Promise<string> {
    const file = this.blob(hash);
    if ((await hashFile(file)) !== hash)
      throw new SyncError(
        'SAFETY',
        'Stored content snapshot is missing or corrupt; publication blocked',
      );
    return file;
  }
  async capture(file: string): Promise<string | null> {
    // Hash the private snapshot, not a potentially changing source.
    const temp = path.join(this.directory, `capture-${randomUUID()}`);
    try {
      await fs.copyFile(file, temp);
      const hash = (await hashFile(temp))!;
      const h = await fs.open(temp, 'r+');
      try {
        await h.sync();
      } finally {
        await h.close();
      }
      await fs.rename(temp, this.blob(hash));
      if (process.platform !== 'win32') {
        const dir = await fs.open(path.join(this.directory, 'blobs'), 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
      return hash;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
}
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async idle(): Promise<void> {
    await this.tail;
  }
}
