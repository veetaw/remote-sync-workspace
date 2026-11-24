import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConnectionManager } from './adapters';
import {
  Connection,
  Operation,
  RemoteEntry,
  SyncError,
  FileState,
  cancelled,
  terminal,
} from './types';
import { Store, Serial, hashFile } from './storage';
import {
  excluded,
  identity,
  localPath,
  relativePath,
  remotePath,
} from './safety';
import { History } from './history';
import { FileComparison } from './file-comparison';

export interface EngineHooks {
  dirty(path: string): boolean;
  changed(): void;
  report(message: string): void;
  confirm(message: string): Promise<boolean>;
  notifyConflict?(path: string, message: string): void;
}
export class SyncEngine {
  readonly serial = new Serial();
  readonly store: Store;
  readonly history: History;
  paused = false;
  readonly transfers = new Map<string, FileState>();
  private closing = false;
  private lock?: fs.FileHandle;
  constructor(
    readonly config: Connection,
    directory: string,
    readonly connection: ConnectionManager,
    readonly hooks: EngineHooks,
  ) {
    this.store = new Store(directory);
    this.history = new History(
      path.join(directory, 'history.git'),
      config.localRoot,
    );
  }
  async open(): Promise<void> {
    await fs.mkdir(this.store.directory, { recursive: true });
    // Cross-extension-host lock. Never break a live process lock.
    const lockFile = path.join(this.store.directory, 'lock');
    try {
      this.lock = await fs.open(lockFile, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(await fs.readFile(lockFile, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error('Invalid workspace lock; inspect it before recovery.', {
          cause: e,
        });
      try {
        process.kill(pid, 0);
        throw new Error(
          'Workspace is already active in another extension host.',
          { cause: e },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await fs.unlink(lockFile);
      this.lock = await fs.open(lockFile, 'wx');
    }
    await this.lock.writeFile(String(process.pid));
    await this.lock.sync();
    try {
      await localPath(this.config.localRoot, '');
      await fs.mkdir(this.config.localRoot, { recursive: true });
      await this.store.open(identity(this.config));
      await this.history.init();
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.serial.idle();
    await this.connection.invalidate();
    if (this.lock) {
      await this.lock.close();
      this.lock = undefined;
      await fs.unlink(path.join(this.store.directory, 'lock'));
    }
  }
  private allowed(p: string, root = false): void {
    relativePath(p, root);
    if (p && excluded(p, this.config.excludes))
      throw new SyncError('SAFETY', 'Excluded path');
  }
  private async persist(): Promise<void> {
    await this.store.save();
    this.hooks.changed();
  }
  private async list(p: string, signal?: AbortSignal): Promise<RemoteEntry[]> {
    this.allowed(p, true);
    cancelled(signal);
    const adapter = await this.connection.get();
    const list = await adapter.list(remotePath(this.config.remoteRoot, p), {
      signal,
    });
    const seen = new Set<string>();
    for (const entry of list) {
      relativePath(entry.name);
      if (entry.name.includes('/'))
        throw new SyncError('SAFETY', 'Invalid listing name');
      const key = entry.name.normalize('NFC').toLowerCase();
      if (seen.has(key))
        throw new SyncError('SAFETY', `Case/Unicode collision in ${p}`);
      seen.add(key);
    }
    this.store.state.inventory ??= {};
    this.store.state.inventory[p] = list;
    return list;
  }
  private async entry(
    p: string,
    signal?: AbortSignal,
  ): Promise<RemoteEntry | undefined> {
    this.allowed(p);
    const segments = p.split('/');
    for (let i = 0; i < segments.length; i++) {
      const entries = await this.list(segments.slice(0, i).join('/'), signal);
      if (
        entries.some(
          (e) =>
            e.name !== segments[i] &&
            e.name.normalize('NFC').toLowerCase() ===
              segments[i].normalize('NFC').toLowerCase(),
        )
      )
        throw new SyncError(
          'SAFETY',
          'Remote path differs only in case or Unicode normalization',
        );
      const item = entries.find((e) => e.name === segments[i]);
      if (!item) return undefined;
      if (
        item.type === 'symlink' ||
        (i < segments.length - 1 && item.type !== 'directory')
      )
        throw new SyncError('SAFETY', 'Remote symlink or invalid ancestor');
      if (i === segments.length - 1) return item;
    }
    return undefined;
  }
  private async remoteVersion(
    p: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const entry = await this.entry(p, signal);
    if (!entry) return null;
    if (entry.type !== 'file')
      throw new SyncError('SAFETY', 'Expected remote regular file');
    const temp = path.join(this.store.directory, `download-${randomUUID()}`);
    this.transfers.set(p, 'DOWNLOADING');
    this.hooks.changed();
    try {
      await (
        await this.connection.get()
      ).download(remotePath(this.config.remoteRoot, p), temp, {
        signal,
        progress: (bytes) => this.hooks.report(`${p}: ${bytes} bytes`),
      });
      cancelled(signal);
      const hash = await this.store.capture(temp);
      if (!hash) throw new Error('Download did not produce a file');
      return hash;
    } finally {
      this.transfers.delete(p);
      this.hooks.changed();
      await fs.rm(temp, { force: true });
    }
  }
  private async conflict(
    p: string,
    remote: string | null,
    message: string,
  ): Promise<void> {
    const first = this.store.state.files[p]?.state !== 'CONFLICT';
    const record = this.store.state.files[p] ?? {
      baseline: null,
      state: 'CONFLICT' as const,
    };
    record.state = 'CONFLICT';
    record.remote = remote;
    this.store.state.files[p] = record;
    this.hooks.report(`CONFLICT ${p}: ${message}`);
    await this.persist();
    if (first) this.hooks.notifyConflict?.(p, message);
  }
  private pending(p: string): boolean {
    return this.store.state.operations.some(
      (o) =>
        !terminal(o.state) &&
        (o.path === p ||
          o.destination === p ||
          ((o.type === 'rename' || o.type === 'rmdir') &&
            (p.startsWith(`${o.path}/`) ||
              (!!o.destination && p.startsWith(`${o.destination}/`))))),
    );
  }
  private async applyRemote(
    p: string,
    remote: string | null,
    expected: string | null,
    resolving = false,
  ): Promise<void> {
    const target = await localPath(this.config.localRoot, p);
    if (this.hooks.dirty(p) || (await hashFile(target)) !== expected) {
      await this.conflict(p, remote, 'Local content changed during download');
      return;
    }
    if (expected !== null) {
      const snapshot = await this.store.capture(target);
      await this.history.snapshot(
        p,
        resolving ? 'CONFLICT_RESOLUTION' : 'LOCAL_CHANGE',
        undefined,
        snapshot ? this.store.blob(snapshot) : undefined,
      );
    }
    if (remote === null) {
      // Keep deletion recoverable in Git; never remove directories recursively here.
      if ((await hashFile(target)) !== expected || this.hooks.dirty(p)) {
        await this.conflict(p, remote, 'Local edit during reconciliation');
        return;
      }
      await fs.rm(target, { force: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = path.join(
        path.dirname(target),
        `.remote-sync-${randomUUID()}`,
      );
      try {
        await fs.copyFile(await this.store.verifiedBlob(remote), temporary);
        const handle = await fs.open(temporary, 'r+');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        if ((await hashFile(target)) !== expected || this.hooks.dirty(p)) {
          await this.conflict(p, remote, 'Local edit during reconciliation');
          return;
        }
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
    const initial = !this.store.state.files[p];
    this.store.state.files[p] = {
      baseline: remote,
      remote,
      state: 'SYNCED',
      direction: 'remote',
    };
    await this.history.snapshot(
      p,
      resolving
        ? 'CONFLICT_RESOLUTION'
        : initial
          ? 'INITIAL_REMOTE'
          : 'REMOTE_CHANGE',
    );
    await this.persist();
  }
  materialize(p = '', recursive = false, signal?: AbortSignal): Promise<void> {
    return this.serial.run(async () => {
      try {
        await this.load(p, recursive, signal);
      } catch (e) {
        if (this.store.state) {
          this.store.state.directories[p] = 'ERROR';
          await this.persist();
        }
        await this.connection.invalidate();
        throw e;
      }
    });
  }
  private async load(
    p: string,
    recursive: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    this.allowed(p, true);
    cancelled(signal);
    if (p && (await this.entry(p, signal))?.type !== 'directory')
      throw new SyncError('SAFETY', 'Remote directory missing');
    this.store.state.directories[p] = 'LOADING';
    await this.persist();
    const entries = await this.list(p, signal);
    await fs.mkdir(await localPath(this.config.localRoot, p), {
      recursive: true,
    });
    const visible = new Set<string>();
    let done = 0;
    for (const entry of entries) {
      cancelled(signal);
      const child = p ? `${p}/${entry.name}` : entry.name;
      if (excluded(child, this.config.excludes) || entry.type === 'symlink')
        continue;
      visible.add(child);
      this.hooks.report(`${++done}/${entries.length}: ${child}`);
      if (entry.type === 'directory') {
        if (this.pending(child)) continue;
        const target = await localPath(this.config.localRoot, child);
        await fs.mkdir(target, { recursive: true });
        this.store.state.directories[child] ??= 'DISCOVERED';
        if (recursive) await this.load(child, true, signal);
      } else await this.reconcileFile(child, signal);
    }
    // A successful complete listing is the only evidence for remote absence.
    for (const file of Object.keys(this.store.state.files)) {
      if (
        !excluded(file, this.config.excludes) &&
        path.posix.dirname(file) === (p || '.') &&
        !visible.has(file)
      )
        await this.reconcileFile(file, signal);
    }
    this.store.state.directories[p] = 'MATERIALIZED';
    await this.persist();
  }
  private async reconcileFile(p: string, signal?: AbortSignal): Promise<void> {
    const record = this.store.state.files[p];
    const remote = await this.remoteVersion(p, signal);
    const target = await localPath(this.config.localRoot, p);
    const local = await hashFile(target);
    if (record?.state === 'CONFLICT' || this.pending(p)) {
      if (record && remote !== record.baseline)
        await this.conflict(
          p,
          remote,
          'Remote changed with pending local operation',
        );
      return;
    }
    if (!record) {
      if (local !== null && local !== remote) {
        await this.store.capture(target);
        await this.history.snapshot(p, 'LOCAL_CHANGE');
        await this.conflict(p, remote, 'Pre-existing local file');
      } else if (local === remote) {
        this.store.state.files[p] = {
          baseline: remote,
          state: 'SYNCED',
          remote,
        };
        if (local) {
          await this.store.capture(target);
          await this.history.snapshot(p, 'INITIAL_REMOTE');
        }
      } else await this.applyRemote(p, remote, local);
      return;
    }
    if (local !== record.baseline || this.hooks.dirty(p)) {
      if (remote !== record.baseline && remote !== local)
        await this.conflict(p, remote, 'Both versions changed');
      else if (!this.hooks.dirty(p)) await this.enqueueUploadOrDelete(p, local);
    } else if (remote !== record.baseline)
      await this.applyRemote(p, remote, local);
  }
  sync(signal?: AbortSignal, publish = false): Promise<void> {
    return this.serial.run(async () => {
      try {
        cancelled(signal);
        await this.reconcileInterrupted();
        const dirs = Object.entries(this.store.state.directories);
        await this.load('', false, signal);
        for (const [dir, state] of dirs)
          if (dir) {
            cancelled(signal);
            if (this.pending(dir)) continue;
            const entry = await this.entry(dir, signal);
            if (!entry) {
              this.hooks.report(
                `Remote directory absent: ${dir}; local content retained`,
              );
              continue;
            }
            if (state === 'MATERIALIZED') await this.load(dir, false, signal);
            else await this.list(dir, signal); // Refresh known lazy inventory without materializing content.
          }
        await this.scanLocal('');
        cancelled(signal);
        this.store.state.lastSync = new Date().toISOString();
        await this.persist();
        for (const op of this.store.state.operations)
          if (
            op.state === 'FAILED' &&
            op.retryable &&
            op.attempts <= this.config.retryAttempts
          )
            op.state = 'PENDING';
        await this.persist();
        await this.drainInternal(publish);
      } catch (e) {
        await this.connection.invalidate();
        throw e;
      }
    });
  }
  private async scanLocal(dir: string): Promise<void> {
    for (const item of await fs.readdir(
      await localPath(this.config.localRoot, dir),
      { withFileTypes: true },
    )) {
      const p = dir ? `${dir}/${item.name}` : item.name;
      if (excluded(p, this.config.excludes) || item.isSymbolicLink()) continue;
      this.allowed(p);
      if (item.isDirectory()) {
        if (this.pending(p)) continue;
        if (!this.store.state.directories[p])
          await this.enqueue('mkdir', p, null);
        await this.scanLocal(p);
      } else if (item.isFile() && !this.hooks.dirty(p)) {
        const hash = await hashFile(await localPath(this.config.localRoot, p));
        if (hash !== this.store.state.files[p]?.baseline && !this.pending(p))
          await this.enqueueUploadOrDelete(p, hash);
      }
    }
    for (const p of Object.keys(this.store.state.files)) {
      if (
        !excluded(p, this.config.excludes) &&
        path.posix.dirname(p) === (dir || '.') &&
        this.store.state.files[p].baseline !== null &&
        !this.pending(p) &&
        (await hashFile(await localPath(this.config.localRoot, p))) === null
      )
        await this.enqueueUploadOrDelete(p, null);
    }
  }
  scanLocalChanges(): Promise<void> {
    return this.serial.run(async () => {
      if (this.closing) return;
      await this.scanLocal('');
      await this.drainInternal();
    });
  }
  localChange(
    p: string,
    event: 'file' | 'directory' | 'delete' | 'rmdir' = 'file',
  ): Promise<void> {
    return this.serial.run(async () => {
      if (this.closing || excluded(p, this.config.excludes)) return;
      this.allowed(p);
      if (event === 'directory') {
        if (!this.store.state.directories[p])
          await this.enqueue('mkdir', p, null);
      } else if (event === 'rmdir') {
        if (this.store.state.directories[p] !== 'MATERIALIZED') {
          this.hooks.report(
            `Lazy directory deletion blocked: ${p}. Download/refresh it first.`,
          );
          return;
        }
        await this.enqueue('rmdir', p, null);
      } else if (!this.hooks.dirty(p))
        await this.enqueueUploadOrDelete(
          p,
          await hashFile(await localPath(this.config.localRoot, p)),
        );
      await this.drainInternal();
    });
  }
  private async enqueueUploadOrDelete(
    p: string,
    hash: string | null,
  ): Promise<void> {
    const record = this.store.state.files[p];
    if (record?.state === 'CONFLICT') return;
    if (
      (hash === record?.baseline && !this.pending(p)) ||
      (!record && hash === null)
    )
      return;
    if (hash) {
      hash = await this.store.capture(
        await localPath(this.config.localRoot, p),
      );
      if (!hash) return;
      await this.history.snapshot(
        p,
        'LOCAL_CHANGE',
        undefined,
        this.store.blob(hash),
      );
    } else if (record?.baseline && !this.pending(p))
      await this.history.snapshot(p, 'LOCAL_CHANGE');
    await this.enqueue(hash ? 'upload' : 'delete', p, hash);
    this.store.state.files[p] ??= { baseline: null, state: 'PENDING' };
    this.store.state.files[p].state = this.pending(p) ? 'PENDING' : 'SYNCED';
    await this.persist();
  }
  private async enqueue(
    type: Operation['type'],
    p: string,
    hash: string | null,
    destination?: string,
  ): Promise<void> {
    const pending = this.store.state.operations.findLast(
      (o) => o.path === p && o.state === 'PENDING',
    );
    if (
      pending &&
      ['upload', 'delete'].includes(pending.type) &&
      ['upload', 'delete'].includes(type) &&
      !this.store.state.operations
        .slice(this.store.state.operations.indexOf(pending) + 1)
        .some((o) => !terminal(o.state))
    ) {
      pending.type = type;
      pending.localVersion = hash;
      pending.timestamp = new Date().toISOString();
      if (type === 'delete' && pending.baseline === null) {
        pending.state = 'CANCELLED';
        pending.error =
          'Unpublished local creation was removed before transfer';
      }
    } else if (pending?.type !== type || pending?.destination !== destination)
      this.store.state.operations.push({
        id: randomUUID(),
        connectionId: this.config.id,
        type,
        path: p,
        destination,
        state: 'PENDING',
        timestamp: new Date().toISOString(),
        attempts: 0,
        localVersion: hash,
        baseline: this.store.state.files[p]?.baseline ?? null,
      });
    await this.persist();
  }
  drain(): Promise<void> {
    return this.serial.run(() => this.drainInternal());
  }
  private async drainInternal(publish = false): Promise<void> {
    if (this.paused || (!this.config.autoUpload && !publish) || this.closing)
      return;
    // Global serialization preserves rename/delete causality, including ancestor paths.
    for (const op of this.store.state.operations) {
      if (terminal(op.state)) continue;
      if (op.state !== 'PENDING') break;
      let mutated = false;
      try {
        this.allowed(op.path);
        if (op.destination) this.allowed(op.destination);
        const adapter = await this.connection.get();
        op.attempts++;
        op.state = 'RUNNING';
        await this.persist();
        if (op.type === 'upload' || op.type === 'delete') {
          const remote = await this.remoteVersion(op.path);
          if (remote !== op.baseline)
            throw new SyncError(
              'CONFLICT',
              'Remote content no longer matches baseline',
            );
          if (op.type === 'delete' && !op.baseline)
            throw new SyncError(
              'SAFETY',
              'Cannot delete a remote file without recoverable baseline',
            );
          if (
            op.type === 'delete' &&
            !op.approved &&
            this.config.confirmMassDelete &&
            !(await this.hooks.confirm(
              `Delete remote file ${op.path}? Its baseline is recoverable in local history.`,
            ))
          )
            throw new SyncError('SAFETY', 'Deletion not confirmed');
          if (op.type === 'upload') {
            if (!op.localVersion) throw new Error('Missing upload snapshot');
            this.store.state.files[op.path].state = 'UPLOADING';
            await this.persist();
            const snapshot = await this.store.verifiedBlob(op.localVersion);
            mutated = true;
            await adapter.upload(
              snapshot,
              remotePath(this.config.remoteRoot, op.path),
            );
          } else {
            mutated = true;
            await adapter.deleteFile(
              remotePath(this.config.remoteRoot, op.path),
            );
          }
          const verified = await this.remoteVersion(op.path);
          if (verified !== op.localVersion)
            throw new SyncError(
              'UNCERTAIN',
              'Post-transfer content verification failed',
            );
          this.store.state.files[op.path] = {
            baseline: verified,
            remote: verified,
            state: 'SYNCED',
            direction: 'local',
          };
        } else if (op.type === 'mkdir') {
          const existing = await this.entry(op.path);
          if (existing && existing.type !== 'directory')
            throw new SyncError('CONFLICT', 'Remote destination exists');
          if (!existing) {
            mutated = true;
            await adapter.mkdir(remotePath(this.config.remoteRoot, op.path));
          }
          if ((await this.entry(op.path))?.type !== 'directory')
            throw new SyncError('UNCERTAIN', 'Directory creation not verified');
          this.store.state.directories[op.path] = existing
            ? (this.store.state.directories[op.path] ?? 'DISCOVERED')
            : 'MATERIALIZED';
        } else if (op.type === 'rmdir') {
          if (this.store.state.directories[op.path] !== 'MATERIALIZED')
            throw new SyncError('SAFETY', 'Lazy directory cannot be deleted');
          if ((await this.list(op.path)).length)
            throw new SyncError(
              'CONFLICT',
              'Remote directory is not empty; recursive removal blocked',
            );
          if (
            !op.approved &&
            this.config.confirmMassDelete &&
            !(await this.hooks.confirm(
              `Remove empty remote directory ${op.path}?`,
            ))
          )
            throw new SyncError('SAFETY', 'Removal not confirmed');
          mutated = true;
          await adapter.deleteDirectory(
            remotePath(this.config.remoteRoot, op.path),
          );
          if (await this.entry(op.path))
            throw new SyncError('UNCERTAIN', 'Directory removal not verified');
          delete this.store.state.directories[op.path];
        } else {
          const dest = op.destination!;
          if (await this.entry(dest))
            throw new SyncError(
              'CONFLICT',
              'Rename destination already exists',
            );
          const source = await this.entry(op.path);
          if (source?.type === 'directory') {
            if (
              !op.tree ||
              JSON.stringify(await this.tree(op.path)) !==
                JSON.stringify(op.tree)
            )
              throw new SyncError(
                'CONFLICT',
                'Directory contents changed before rename',
              );
          } else if (
            source?.type !== 'file' ||
            (await this.remoteVersion(op.path)) !== op.baseline
          )
            throw new SyncError('CONFLICT', 'Rename source changed remotely');
          mutated = true;
          await adapter.rename(
            remotePath(this.config.remoteRoot, op.path),
            remotePath(this.config.remoteRoot, dest),
          );
          if (await this.entry(op.path))
            throw new SyncError('UNCERTAIN', 'Rename source still exists');
          if (source.type === 'directory') {
            if (
              JSON.stringify(await this.tree(dest)) !== JSON.stringify(op.tree)
            )
              throw new SyncError(
                'UNCERTAIN',
                'Directory rename content not verified',
              );
            this.remap(op.path, dest);
          } else {
            if ((await this.remoteVersion(dest)) !== op.baseline)
              throw new SyncError('UNCERTAIN', 'Rename not verified');
            this.store.state.files[dest] = {
              baseline: op.baseline,
              state: 'SYNCED',
              direction: 'local',
            };
            delete this.store.state.files[op.path];
          }
          await this.history.move(op.path, dest);
        }
        op.state = 'VERIFIED';
        op.error = undefined;
        await this.persist();
        if (op.type === 'upload' || (op.type === 'rename' && !op.tree)) {
          const p = op.destination ?? op.path;
          const latest = await hashFile(
            await localPath(this.config.localRoot, p),
          );
          if (latest !== this.store.state.files[p]?.baseline)
            await this.enqueueUploadOrDelete(p, latest);
        }
      } catch (e) {
        op.state = mutated
          ? 'UNCERTAIN'
          : e instanceof SyncError && e.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'FAILED';
        op.retryable =
          !mutated && (!(e instanceof SyncError) || e.code === 'NETWORK');
        // Protocol errors can contain credentials; persist only controlled messages.
        op.error =
          e instanceof SyncError
            ? e.message
            : 'Connection or filesystem operation failed; check connectivity and permissions';
        const record = this.store.state.files[op.path];
        if (record)
          record.state = op.state === 'CONFLICT' ? 'CONFLICT' : 'ERROR';
        if (
          op.state === 'CONFLICT' &&
          (op.type === 'upload' ||
            op.type === 'delete' ||
            (op.type === 'rename' && !op.tree))
        )
          await this.conflict(
            op.path,
            await this.remoteVersion(op.path).catch(() => null),
            op.error,
          );
        else if (op.state === 'CONFLICT')
          this.store.state.directories[op.path] = 'ERROR';
        await this.persist();
        this.hooks.report(`${op.state} ${op.path}: ${op.error}`);
        await this.connection.invalidate();
        break;
      }
    }
  }
  private async reconcileInterrupted(): Promise<void> {
    for (const op of this.store.state.operations) {
      if (op.state !== 'UNCERTAIN') continue;
      if (op.type === 'upload' || op.type === 'delete') {
        const remote = await this.remoteVersion(op.path);
        if (remote === op.localVersion) {
          op.state = 'VERIFIED';
          this.store.state.files[op.path] = {
            baseline: remote,
            remote,
            state: 'SYNCED',
            direction: 'local',
          };
        } else
          await this.conflict(
            op.path,
            remote,
            'Interrupted transfer requires explicit resolution',
          );
      } else if (
        op.type === 'mkdir' &&
        (await this.entry(op.path))?.type === 'directory'
      ) {
        this.store.state.directories[op.path] = 'MATERIALIZED';
        op.state = 'VERIFIED';
      } else if (op.type === 'rmdir' && !(await this.entry(op.path))) {
        delete this.store.state.directories[op.path];
        op.state = 'VERIFIED';
      } else if (
        op.type === 'rename' &&
        op.destination &&
        !(await this.entry(op.path))
      ) {
        const destination = await this.entry(op.destination);
        if (
          op.tree &&
          destination?.type === 'directory' &&
          JSON.stringify(await this.tree(op.destination)) ===
            JSON.stringify(op.tree)
        ) {
          this.remap(op.path, op.destination);
          op.state = 'VERIFIED';
        } else if (
          !op.tree &&
          destination?.type === 'file' &&
          (await this.remoteVersion(op.destination)) === op.baseline
        ) {
          this.store.state.files[op.destination] = {
            baseline: op.baseline,
            state: 'SYNCED',
            direction: 'local',
          };
          delete this.store.state.files[op.path];
          op.state = 'VERIFIED';
        }
      }
      if (op.state === 'UNCERTAIN')
        this.hooks.report(
          `UNCERTAIN ${op.type}: ${op.path}; inspect remote before manual recovery`,
        );
    }
    await this.persist();
  }
  private remap(from: string, to: string): void {
    for (const map of [this.store.state.files, this.store.state.directories])
      for (const key of Object.keys(map))
        if (key === from || key.startsWith(`${from}/`)) {
          Object.assign(map, { [to + key.slice(from.length)]: map[key] });
          delete map[key];
        }
  }
  recoverOperation(id: string, cancel = false): Promise<void> {
    return this.serial.run(async () => {
      const op = this.store.state.operations.find((o) => o.id === id);
      if (!op || terminal(op.state) || op.state === 'RUNNING') return;
      await this.reconcileInterrupted();
      if (terminal(op.state)) return;
      if (cancel) {
        if (
          !(await this.hooks.confirm(
            `Abandon ${op.type} ${op.path}? This does not undo remote effects. Both sides must be reconciled before further publication.`,
          ))
        )
          return;
        op.state = 'CANCELLED';
        op.error = 'Explicitly abandoned; remote effects not undone';
        if (op.type === 'upload' || op.type === 'delete')
          await this.conflict(
            op.path,
            await this.remoteVersion(op.path),
            'Abandoned operation requires manual resolution',
          );
        else {
          this.paused = true;
          for (const [p, record] of Object.entries(this.store.state.files))
            if (
              p === op.path ||
              p.startsWith(`${op.path}/`) ||
              p === op.destination ||
              (!!op.destination && p.startsWith(`${op.destination}/`))
            )
              record.state = 'CONFLICT';
        }
      } else {
        if (op.type === 'upload' || op.type === 'delete')
          throw new SyncError(
            'SAFETY',
            'Resolve file uncertainty with Keep Remote or Keep Local & Upload',
          );
        // A structural retry is allowed only after proving the original precondition still holds.
        if (op.type === 'rename') {
          if (!op.destination || (await this.entry(op.destination)))
            throw new SyncError(
              'CONFLICT',
              'Destination exists; structural retry blocked',
            );
          if (
            op.tree
              ? JSON.stringify(await this.tree(op.path)) !==
                JSON.stringify(op.tree)
              : (await this.remoteVersion(op.path)) !== op.baseline
          )
            throw new SyncError(
              'CONFLICT',
              'Source changed; structural retry blocked',
            );
        } else if (op.type === 'rmdir' && (await this.list(op.path)).length)
          throw new SyncError('CONFLICT', 'Remote directory is not empty');
        else if (op.type === 'mkdir' && (await this.entry(op.path)))
          throw new SyncError(
            'CONFLICT',
            'Destination exists; refresh before retry',
          );
        if (
          !(await this.hooks.confirm(
            `Retry verified structural operation ${op.type}: ${op.path}?`,
          ))
        )
          return;
        op.state = 'PENDING';
        op.error = undefined;
      }
      await this.persist();
      await this.drainInternal();
    });
  }
  retryFailed(): Promise<void> {
    return this.serial.run(async () => {
      for (const op of this.store.state.operations)
        if (
          op.state === 'FAILED' &&
          op.attempts < this.config.retryAttempts + 1
        )
          op.state = 'PENDING';
      await this.persist();
      await this.drainInternal();
    });
  }
  rename(from: string, to: string): Promise<void> {
    return this.serial.run(async () => {
      this.allowed(from);
      this.allowed(to);
      if (
        this.config.confirmRename &&
        !(await this.hooks.confirm(`Rename remote ${from} to ${to}?`))
      )
        return;
      if (to.startsWith(`${from}/`))
        throw new SyncError('SAFETY', 'Cannot move a directory into itself');
      if (
        this.store.state.operations.some(
          (o) =>
            !terminal(o.state) &&
            (o.path === from || o.path.startsWith(`${from}/`)),
        ) ||
        Object.entries(this.store.state.files).some(
          ([p, r]) =>
            (p === from || p.startsWith(`${from}/`)) && r.state === 'CONFLICT',
        )
      )
        throw new SyncError(
          'CONFLICT',
          'Resolve source operations before rename',
        );
      let tree: Record<string, string | null> | undefined;
      if (this.store.state.directories[from]) {
        tree = await this.tree(from);
        for (const [rel, hash] of Object.entries(tree))
          if (hash !== null) {
            const known = this.store.state.files[`${from}/${rel}`];
            if (known && known.baseline !== hash)
              throw new SyncError(
                'CONFLICT',
                'Remote descendant changed before directory rename',
              );
          }
      }
      await this.enqueue('rename', from, null, to);
      const operation = this.store.state.operations.findLast(
        (o) => o.path === from && o.state === 'PENDING',
      );
      if (operation) operation.tree = tree;
      await this.persist();
      await this.drainInternal();
    });
  }
  private async tree(root: string): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    const walk = async (dir: string): Promise<void> => {
      for (const item of (await this.list(dir)).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const p = `${dir}/${item.name}`;
        if (item.type === 'symlink' || excluded(p, this.config.excludes))
          throw new SyncError(
            'SAFETY',
            'Directory mutation blocked by symlink or excluded descendant',
          );
        const rel = p.slice(root.length + 1);
        if (item.type === 'directory') {
          result[rel] = null;
          await walk(p);
        } else result[rel] = await this.remoteVersion(p);
      }
    };
    await walk(root);
    return result;
  }
  preserve(paths: string[]): Promise<void> {
    return this.serial.run(async () => {
      for (const root of paths) {
        this.allowed(root);
        const walk = async (p: string): Promise<void> => {
          const target = await localPath(this.config.localRoot, p);
          let st;
          try {
            st = await fs.lstat(target);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw e;
          }
          if (st.isDirectory()) {
            for (const child of await fs.readdir(target)) {
              const next = `${p}/${child}`;
              if (!excluded(next, this.config.excludes)) await walk(next);
            }
          } else if (st.isFile()) {
            const hash = await this.store.capture(target);
            if (hash && hash !== this.store.state.files[p]?.baseline)
              await this.history.snapshot(
                p,
                'LOCAL_CHANGE',
                undefined,
                this.store.blob(hash),
              );
          }
        };
        await walk(root);
      }
    });
  }
  deleteLocal(paths: string[]): Promise<void> {
    return this.serial.run(async () => {
      for (const root of paths) this.allowed(root);
      const dirs = Object.keys(this.store.state.directories).filter(
        (p) =>
          p && paths.some((root) => p === root || p.startsWith(`${root}/`)),
      );
      if (dirs.some((p) => this.store.state.directories[p] !== 'MATERIALIZED'))
        throw new SyncError(
          'SAFETY',
          'Remote deletion blocked: selected tree contains lazy or uncertain directories. Refresh/download it before deleting remotely.',
        );
      const files = Object.keys(this.store.state.files).filter((p) =>
        paths.some((root) => p === root || p.startsWith(`${root}/`)),
      );
      if (
        this.config.confirmMassDelete &&
        !(await this.hooks.confirm(
          `Delete ${files.length} remote files and ${dirs.length} directories? Each file baseline will be checked; non-empty or changed directories are blocked.`,
        ))
      )
        throw new SyncError(
          'SAFETY',
          'Remote deletion not confirmed; local deletion is retained for reconciliation',
        );
      for (const p of files) {
        await this.enqueueUploadOrDelete(p, null);
        const op = this.store.state.operations.findLast(
          (o) => o.path === p && o.state === 'PENDING' && o.type === 'delete',
        );
        if (op) op.approved = true;
      }
      for (const p of dirs.sort(
        (a, b) => b.split('/').length - a.split('/').length,
      )) {
        await this.enqueue('rmdir', p, null);
        const op = this.store.state.operations.findLast(
          (o) => o.path === p && o.state === 'PENDING',
        );
        if (op) op.approved = true;
      }
      await this.persist();
      await this.drainInternal();
    });
  }
  resolve(p: string, choice: 'remote' | 'local'): Promise<void> {
    return this.serial.run(async () => {
      this.allowed(p);
      if (this.hooks.dirty(p))
        throw new SyncError(
          'SAFETY',
          'Save or close the dirty editor before resolving',
        );
      const remote = await this.remoteVersion(p);
      const local = await hashFile(await localPath(this.config.localRoot, p));
      if (local) {
        await this.store.capture(await localPath(this.config.localRoot, p));
        await this.history.snapshot(p, 'CONFLICT_RESOLUTION');
      }
      // Explicit selection authorizes a freshly checked baseline, never a blind retry.
      for (const op of this.store.state.operations)
        if (op.path === p && !terminal(op.state)) {
          op.state = 'CANCELLED';
          op.error =
            'Superseded by explicit conflict resolution; original operation not declared successful';
        }
      if (choice === 'remote') await this.applyRemote(p, remote, local, true);
      else {
        this.store.state.files[p] = {
          baseline: remote,
          remote,
          state: 'PENDING',
        };
        await this.enqueueUploadOrDelete(p, local);
      }
      await this.persist();
      await this.drainInternal();
    });
  }
  async conflictVersions(
    p: string,
  ): Promise<{ local: string; remote?: string; baseline?: string }> {
    return this.serial.run(async () => {
      this.allowed(p);
      const remote = await this.remoteVersion(p);
      const baseline = this.store.state.files[p]?.baseline;
      return {
        local: await localPath(this.config.localRoot, p),
        remote: remote ? await this.store.verifiedBlob(remote) : undefined,
        baseline: baseline
          ? await this.store.verifiedBlob(baseline)
          : undefined,
      };
    });
  }
  inspectFile(p: string, signal?: AbortSignal): Promise<FileComparison> {
    return this.serial.run(async () => {
      this.allowed(p);
      if (this.closing) throw new SyncError('CANCELLED', 'Workspace closed');
      try {
        const remote = await this.remoteVersion(p, signal);
        const local = await hashFile(await localPath(this.config.localRoot, p));
        return {
          baseline: this.store.state.files[p]?.baseline ?? null,
          local,
          remote,
          checkedAt: new Date().toISOString(),
        };
      } catch (e) {
        await this.connection.invalidate();
        throw e;
      }
    });
  }
  restore(p: string, source: string): Promise<void> {
    return this.serial.run(async () => {
      this.allowed(p);
      if (this.hooks.dirty(p))
        throw new SyncError(
          'SAFETY',
          'Save or close the editor before restoring',
        );
      const target = await localPath(this.config.localRoot, p);
      const existing = await hashFile(target);
      if (existing) {
        await this.store.capture(target);
        await this.history.snapshot(p, 'LOCAL_CHANGE');
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = path.join(
        path.dirname(target),
        `.remote-sync-${randomUUID()}`,
      );
      try {
        await fs.copyFile(source, temp);
        if ((await hashFile(target)) !== existing || this.hooks.dirty(p))
          throw new SyncError(
            'CONFLICT',
            'Local content changed during restore',
          );
        await fs.rename(temp, target);
      } finally {
        await fs.rm(temp, { force: true });
      }
      await this.history.snapshot(p, 'MANUAL_RESTORE');
      await this.enqueueUploadOrDelete(p, await hashFile(target));
      await this.drainInternal();
    });
  }
}
