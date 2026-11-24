import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers';
import { hashFile } from '../src/storage';
import { SyncEngine } from '../src/engine';
import { ConnectionManager } from '../src/adapters';

describe('SyncEngine with real disk, persistent state and Git', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await f.engine.close();
    await fs.rm(f.root, { recursive: true, force: true });
  });
  const remoteWrite = async (
    f: Awaited<ReturnType<typeof fixture>>,
    p: string,
    data: string | Buffer,
  ) => {
    const target = path.join(f.remote.root, p);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  };
  const localWrite = async (
    f: Awaited<ReturnType<typeof fixture>>,
    p: string,
    data: string | Buffer,
  ) => {
    const target = path.join(f.local, p);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  };
  async function initial(): Promise<void> {
    await remoteWrite(f, 'index.php', '<?php echo 1;');
    await f.engine.sync();
  }
  it('downloads root files and real zero-byte files, leaves subdirectories lazy', async () => {
    await remoteWrite(f, 'index.php', '<?php');
    await remoteWrite(f, 'empty.php', '');
    await remoteWrite(f, 'lib/x.php', 'x');
    await fs.mkdir(path.join(f.remote.root, 'empty-dir'));
    await f.engine.sync();
    expect(await fs.readFile(path.join(f.local, 'empty.php'), 'utf8')).toBe('');
    expect(await fs.readdir(path.join(f.local, 'lib'))).toEqual([]);
    expect(f.engine.store.state.directories.lib).toBe('DISCOVERED');
    await f.engine.materialize('lib');
    expect(await fs.readFile(path.join(f.local, 'lib/x.php'), 'utf8')).toBe(
      'x',
    );
    await f.engine.materialize('empty-dir');
    expect(f.engine.store.state.directories['empty-dir']).toBe('MATERIALIZED');
  });
  it('downloads recursively for indexing with exclusions', async () => {
    await remoteWrite(f, 'lib/deep/x.php', 'x');
    await remoteWrite(f, 'excluded/a.php', 'secret');
    await f.engine.materialize('', true);
    expect(
      await fs.readFile(path.join(f.local, 'lib/deep/x.php'), 'utf8'),
    ).toBe('x');
    await expect(fs.access(path.join(f.local, 'excluded'))).rejects.toThrow();
  });
  it('publishes a new local binary file and verifies full content', async () => {
    await f.engine.sync();
    const content = Buffer.from([0, 255, 23, 10]);
    await localWrite(f, 'image.bin', content);
    await f.engine.localChange('image.bin');
    expect(await fs.readFile(path.join(f.remote.root, 'image.bin'))).toEqual(
      content,
    );
    expect(f.engine.store.state.files['image.bin'].state).toBe('SYNCED');
  });
  it('coalesces repeated watcher events', async () => {
    await initial();
    await localWrite(f, 'index.php', 'saved');
    await Promise.all(
      Array.from({ length: 5 }, () => f.engine.localChange('index.php')),
    );
    expect(f.remote.uploads).toBe(1);
  });
  it('does not upload extension-generated downloads', async () => {
    await initial();
    await f.engine.localChange('index.php');
    expect(f.remote.uploads).toBe(0);
  });
  it('uses recoverable immutable upload snapshots when local content changes during transfer', async () => {
    await initial();
    await localWrite(f, 'index.php', 'first');
    let once = false;
    f.remote.duringUpload = async () => {
      if (!once) {
        once = true;
        await localWrite(f, 'index.php', 'second');
      }
    };
    await f.engine.localChange('index.php');
    expect(
      await fs.readFile(path.join(f.remote.root, 'index.php'), 'utf8'),
    ).toBe('second');
    expect(f.remote.uploads).toBe(2);
  });
  it('updates remote-only changes and records remote history', async () => {
    await initial();
    await remoteWrite(f, 'index.php', 'remote update');
    await f.engine.sync();
    expect(await fs.readFile(path.join(f.local, 'index.php'), 'utf8')).toBe(
      'remote update',
    );
    expect(await f.engine.history.log()).toContain('REMOTE_CHANGE');
  });
  it('does not rely on equal remote size or timestamps', async () => {
    await remoteWrite(f, 'a', 'aaaa');
    await f.engine.sync();
    await remoteWrite(f, 'a', 'bbbb');
    await f.engine.sync();
    expect(await fs.readFile(path.join(f.local, 'a'), 'utf8')).toBe('bbbb');
  });
  it('preserves both sides of a conflict', async () => {
    await initial();
    await localWrite(f, 'index.php', 'local');
    await remoteWrite(f, 'index.php', 'remote');
    await f.engine.localChange('index.php');
    expect(f.engine.store.state.files['index.php'].state).toBe('CONFLICT');
    expect(
      await fs.readFile(path.join(f.remote.root, 'index.php'), 'utf8'),
    ).toBe('remote');
    expect(await fs.readFile(path.join(f.local, 'index.php'), 'utf8')).toBe(
      'local',
    );
    const versions = await f.engine.conflictVersions('index.php');
    expect(await fs.readFile(versions.baseline!, 'utf8')).toBe('<?php echo 1;');
    await f.engine.resolve('index.php', 'remote');
    expect(await f.engine.history.log()).toContain('CONFLICT_RESOLUTION');
    expect(await fs.readFile(path.join(f.local, 'index.php'), 'utf8')).toBe(
      'remote',
    );
  });
  it('explicit Keep Local authorizes freshly checked remote baseline', async () => {
    await initial();
    await localWrite(f, 'index.php', 'local');
    await remoteWrite(f, 'index.php', 'remote');
    await f.engine.sync();
    await f.engine.resolve('index.php', 'local');
    expect(
      await fs.readFile(path.join(f.remote.root, 'index.php'), 'utf8'),
    ).toBe('local');
  });
  it('protects unsaved editor changes', async () => {
    await initial();
    f.dirty.add('index.php');
    await remoteWrite(f, 'index.php', 'remote');
    await f.engine.sync();
    expect(await fs.readFile(path.join(f.local, 'index.php'), 'utf8')).toBe(
      '<?php echo 1;',
    );
    expect(f.engine.store.state.files['index.php'].state).toBe('CONFLICT');
  });
  it('never overwrites a pre-existing divergent local workspace', async () => {
    await localWrite(f, 'index.php', 'existing');
    await initial();
    expect(await fs.readFile(path.join(f.local, 'index.php'), 'utf8')).toBe(
      'existing',
    );
    expect(f.engine.store.state.files['index.php'].state).toBe('CONFLICT');
  });
  it('treats interrupted direct upload as UNCERTAIN with complete local snapshot', async () => {
    await initial();
    f.remote.failUpload = true;
    await localWrite(f, 'index.php', 'complete local');
    await f.engine.localChange('index.php');
    expect(f.engine.store.state.operations.at(-1)?.state).toBe('UNCERTAIN');
    expect(await fs.readFile(path.join(f.local, 'index.php'), 'utf8')).toBe(
      'complete local',
    );
    f.remote.failUpload = false;
    await f.engine.sync();
    expect(f.remote.uploads).toBe(1);
    expect(f.engine.store.state.files['index.php'].state).toBe('CONFLICT');
  });
  it('does not mark failed post-upload verification as synchronized', async () => {
    await initial();
    f.remote.corruptUpload = true;
    await localWrite(f, 'index.php', 'new');
    await f.engine.localChange('index.php');
    expect(f.engine.store.state.operations.at(-1)?.state).toBe('UNCERTAIN');
    expect(f.engine.store.state.files['index.php'].state).toBe('ERROR');
  });
  it('never substitutes a partial download for the local file', async () => {
    await initial();
    await remoteWrite(f, 'index.php', 'remote new');
    f.remote.failDownload = true;
    await expect(f.engine.sync()).rejects.toThrow();
    expect(await fs.readFile(path.join(f.local, 'index.php'), 'utf8')).toBe(
      '<?php echo 1;',
    );
  });
  it('a failed listing is not evidence of deletion', async () => {
    await initial();
    f.remote.failList = true;
    await expect(f.engine.sync()).rejects.toThrow();
    expect(await hashFile(path.join(f.local, 'index.php'))).toBe(
      f.engine.store.state.files['index.php'].baseline,
    );
  });
  it('propagates a local file deletion with recoverable baseline', async () => {
    await initial();
    await fs.unlink(path.join(f.local, 'index.php'));
    await f.engine.localChange('index.php', 'delete');
    await expect(
      fs.access(path.join(f.remote.root, 'index.php')),
    ).rejects.toThrow();
    expect(await f.engine.history.log('index.php')).toContain('INITIAL_REMOTE');
  });
  it('propagates a remote file deletion without losing history', async () => {
    await initial();
    await fs.unlink(path.join(f.remote.root, 'index.php'));
    await f.engine.sync();
    await expect(fs.access(path.join(f.local, 'index.php'))).rejects.toThrow();
    expect(await f.engine.history.log('index.php')).toContain('REMOTE_CHANGE');
  });
  it('blocks deleting a lazy remote directory', async () => {
    await remoteWrite(f, 'lazy/file', 'valuable');
    await f.engine.sync();
    await fs.rmdir(path.join(f.local, 'lazy'));
    await f.engine.localChange('lazy', 'rmdir');
    expect(
      await fs.readFile(path.join(f.remote.root, 'lazy/file'), 'utf8'),
    ).toBe('valuable');
    expect(f.engine.store.state.operations).toEqual([]);
  });
  it('creates and removes an empty materialized directory', async () => {
    await f.engine.sync();
    await fs.mkdir(path.join(f.local, 'new'));
    await f.engine.localChange('new', 'directory');
    expect(f.engine.store.state.directories.new).toBe('MATERIALIZED');
    await fs.rmdir(path.join(f.local, 'new'));
    await f.engine.localChange('new', 'rmdir');
    await expect(fs.access(path.join(f.remote.root, 'new'))).rejects.toThrow();
  });
  it('rejects removal of a materialized directory with unseen remote descendants', async () => {
    await fs.mkdir(path.join(f.remote.root, 'dir'));
    await f.engine.materialize('dir');
    await remoteWrite(f, 'dir/new', 'new');
    await fs.rmdir(path.join(f.local, 'dir'));
    await f.engine.localChange('dir', 'rmdir');
    expect(f.engine.store.state.operations.at(-1)?.state).toBe('CONFLICT');
    expect(await fs.readFile(path.join(f.remote.root, 'dir/new'), 'utf8')).toBe(
      'new',
    );
  });
  it('renames a file with source and destination verification', async () => {
    await initial();
    await fs.rename(
      path.join(f.local, 'index.php'),
      path.join(f.local, 'moved.php'),
    );
    await f.engine.rename('index.php', 'moved.php');
    expect(
      await fs.readFile(path.join(f.remote.root, 'moved.php'), 'utf8'),
    ).toBe('<?php echo 1;');
    expect(f.engine.store.state.files['moved.php'].state).toBe('SYNCED');
  });
  it('renames a lazy directory only after preserving and verifying all remote content', async () => {
    await remoteWrite(f, 'dir/deep/a.php', 'a');
    await f.engine.sync();
    await fs.rename(path.join(f.local, 'dir'), path.join(f.local, 'new'));
    await f.engine.rename('dir', 'new');
    expect(
      await fs.readFile(path.join(f.remote.root, 'new/deep/a.php'), 'utf8'),
    ).toBe('a');
    expect(f.engine.store.state.directories.new).toBe('DISCOVERED');
  });
  it('never renames over an existing destination', async () => {
    await initial();
    await remoteWrite(f, 'dest.php', 'keep');
    await fs.rename(
      path.join(f.local, 'index.php'),
      path.join(f.local, 'dest.php'),
    );
    await f.engine.rename('index.php', 'dest.php');
    expect(
      await fs.readFile(path.join(f.remote.root, 'dest.php'), 'utf8'),
    ).toBe('keep');
    expect(f.engine.store.state.operations.at(-1)?.state).toBe('CONFLICT');
  });
  it('retains a paused queue across restart and reconciles before resuming', async () => {
    await initial();
    f.engine.paused = true;
    await localWrite(f, 'index.php', 'pending');
    await f.engine.localChange('index.php');
    expect(f.engine.store.state.operations.at(-1)?.state).toBe('PENDING');
    const dir = f.engine.store.directory;
    await f.engine.close();
    f.engine = new SyncEngine(
      f.config,
      dir,
      new ConnectionManager(() => f.remote, 0),
      {
        dirty: () => false,
        changed: () => {},
        report: () => {},
        confirm: async () => true,
      },
    );
    await f.engine.open();
    await f.engine.sync();
    expect(
      await fs.readFile(path.join(f.remote.root, 'index.php'), 'utf8'),
    ).toBe('pending');
  });
  it('reconciles RUNNING after a crash instead of replaying blindly', async () => {
    await initial();
    f.engine.paused = true;
    await localWrite(f, 'index.php', 'pending');
    await f.engine.localChange('index.php');
    const operation = f.engine.store.state.operations.at(-1)!;
    operation.state = 'RUNNING';
    await f.engine.store.save();
    const dir = f.engine.store.directory;
    await f.engine.close();
    f.engine = new SyncEngine(
      f.config,
      dir,
      new ConnectionManager(() => f.remote, 0),
      {
        dirty: () => false,
        changed: () => {},
        report: () => {},
        confirm: async () => true,
      },
    );
    await f.engine.open();
    expect(f.engine.store.state.operations.at(-1)?.state).toBe('UNCERTAIN');
    await f.engine.sync();
    expect(f.remote.uploads).toBe(0);
    expect(f.engine.store.state.files['index.php'].state).toBe('CONFLICT');
  });
  it('reconciles successful upload whose completion was not persisted', async () => {
    await initial();
    f.engine.paused = true;
    await localWrite(f, 'index.php', 'pending');
    await f.engine.localChange('index.php');
    f.engine.store.state.operations.at(-1)!.state = 'UNCERTAIN';
    await remoteWrite(f, 'index.php', 'pending');
    await f.engine.sync();
    expect(f.engine.store.state.operations.at(-1)?.state).toBe('VERIFIED');
    expect(f.remote.uploads).toBe(0);
  });
  it('does not upload reserved placeholders or private metadata', async () => {
    for (const p of [
      '[DIR] lib',
      '.git/config',
      '.remote-sync-cache',
      'file.php.tmp',
    ]) {
      await localWrite(f, p, 'never');
      await f.engine.localChange(p);
    }
    expect(f.remote.uploads).toBe(0);
    expect(f.engine.store.state.operations).toEqual([]);
  });
  it('blocks deletion of the remote root and path traversal', async () => {
    await expect(f.engine.localChange('', 'rmdir')).rejects.toThrow();
    await expect(f.engine.localChange('../outside')).rejects.toThrow();
    expect(f.remote.uploads).toBe(0);
  });
  it('detects case collisions before materialization', async () => {
    const original = f.remote.list.bind(f.remote);
    f.remote.list = async (p, c) =>
      p === '/site'
        ? [
            { name: 'A.php', type: 'file', size: 1 },
            { name: 'a.php', type: 'file', size: 1 },
          ]
        : original(p, c);
    await expect(f.engine.sync()).rejects.toThrow('collision');
    expect(await fs.readdir(f.local)).toEqual([]);
  });
  it('cancels scans without marking materialization complete', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.engine.materialize('', true, controller.signal),
    ).rejects.toThrow('cancelled');
    expect(f.engine.store.state.directories['']).toBe('ERROR');
  });
  it('refuses incompatible synchronization identity', async () => {
    const dir = f.engine.store.directory;
    await f.engine.close();
    const other = new SyncEngine(
      { ...f.config, host: 'other' },
      dir,
      new ConnectionManager(() => f.remote, 0),
      f.engine.hooks,
    );
    await expect(other.open()).rejects.toThrow('binding');
  });
  it('requires exclusive workspace ownership across extension hosts', async () => {
    const other = new SyncEngine(
      f.config,
      f.engine.store.directory,
      new ConnectionManager(() => f.remote, 0),
      f.engine.hooks,
    );
    await expect(other.open()).rejects.toThrow('already active');
  });
  it('records history and restores old binary bytes as a new local change', async () => {
    const data = Buffer.from([0, 255, 7]);
    await remoteWrite(f, 'binary', data);
    await f.engine.sync();
    const commit = (await f.engine.history.log('binary')).trim().split(' ')[0];
    await localWrite(f, 'binary', 'changed');
    await f.engine.localChange('binary');
    const temp = path.join(f.root, 'restored');
    await f.engine.history.version(commit, 'binary', temp);
    await f.engine.restore('binary', temp);
    expect(await fs.readFile(path.join(f.remote.root, 'binary'))).toEqual(data);
    expect(await f.engine.history.log()).toContain('MANUAL_RESTORE');
  });
  it('blocks remote deletion when its baseline changed', async () => {
    await initial();
    await remoteWrite(f, 'index.php', 'changed');
    await fs.unlink(path.join(f.local, 'index.php'));
    await f.engine.localChange('index.php', 'delete');
    expect(
      await fs.readFile(path.join(f.remote.root, 'index.php'), 'utf8'),
    ).toBe('changed');
    expect(f.engine.store.state.operations.at(-1)?.state).toBe('CONFLICT');
  });
  it('blocks publication of corrupted private snapshots', async () => {
    await initial();
    f.engine.paused = true;
    await localWrite(f, 'index.php', 'saved');
    await f.engine.localChange('index.php');
    const op = f.engine.store.state.operations.at(-1)!;
    await fs.writeFile(f.engine.store.blob(op.localVersion!), 'tampered');
    f.engine.paused = false;
    await f.engine.drain();
    expect(f.remote.uploads).toBe(0);
    expect(op.state).toBe('FAILED');
  });
  it('coalesces a paused delete followed by recreation without deleting remotely', async () => {
    await initial();
    f.engine.paused = true;
    await fs.unlink(path.join(f.local, 'index.php'));
    await f.engine.localChange('index.php', 'delete');
    await localWrite(f, 'index.php', 'recreated');
    await f.engine.localChange('index.php');
    f.engine.paused = false;
    await f.engine.drain();
    expect(
      await fs.readFile(path.join(f.remote.root, 'index.php'), 'utf8'),
    ).toBe('recreated');
    expect(f.engine.store.state.operations).toHaveLength(1);
  });
  it('cancels a new file removed before publication', async () => {
    await f.engine.sync();
    f.engine.paused = true;
    await localWrite(f, 'new', 'new');
    await f.engine.localChange('new');
    await fs.unlink(path.join(f.local, 'new'));
    await f.engine.localChange('new', 'delete');
    f.engine.paused = false;
    await f.engine.drain();
    expect(f.engine.store.state.operations[0].state).toBe('CANCELLED');
    expect(f.remote.uploads).toBe(0);
  });
  it('manual Sync Now publishes even when automatic upload is disabled', async () => {
    await initial();
    f.config.autoUpload = false;
    await localWrite(f, 'index.php', 'manual');
    await f.engine.localChange('index.php');
    expect(f.remote.uploads).toBe(0);
    await f.engine.sync(undefined, true);
    expect(f.remote.uploads).toBe(1);
  });
  it('batch deletion removes a fully materialized tree in causal order', async () => {
    await remoteWrite(f, 'tree/deep/a', 'a');
    await f.engine.materialize('', true);
    await fs.rm(path.join(f.local, 'tree'), { recursive: true });
    await f.engine.deleteLocal(['tree']);
    await expect(fs.access(path.join(f.remote.root, 'tree'))).rejects.toThrow();
    expect(
      f.engine.store.state.operations.every((o) => o.state === 'VERIFIED'),
    ).toBe(true);
  });
  it('batch deletion blocks the entire lazy tree', async () => {
    await remoteWrite(f, 'tree/known', 'keep');
    await remoteWrite(f, 'tree/deep/a', 'keep');
    await f.engine.materialize('tree');
    await fs.rm(path.join(f.local, 'tree'), { recursive: true });
    await expect(f.engine.deleteLocal(['tree'])).rejects.toThrow('lazy');
    expect(
      await fs.readFile(path.join(f.remote.root, 'tree/known'), 'utf8'),
    ).toBe('keep');
  });
  it('preserves unsynchronized saved bytes before native deletion', async () => {
    await initial();
    await localWrite(f, 'index.php', 'saved then deleted');
    await f.engine.preserve(['index.php']);
    await fs.unlink(path.join(f.local, 'index.php'));
    const commit = (await f.engine.history.log('index.php'))
      .trim()
      .split(' ')[0];
    const file = path.join(f.root, 'recover');
    await f.engine.history.version(commit, 'index.php', file);
    expect(await fs.readFile(file, 'utf8')).toBe('saved then deleted');
  });
  it('reconciles an ambiguous successful file rename without a second rename', async () => {
    await initial();
    f.engine.paused = true;
    await fs.rename(
      path.join(f.local, 'index.php'),
      path.join(f.local, 'moved.php'),
    );
    await f.engine.rename('index.php', 'moved.php');
    const op = f.engine.store.state.operations.at(-1)!;
    op.state = 'UNCERTAIN';
    await fs.rename(
      path.join(f.remote.root, 'index.php'),
      path.join(f.remote.root, 'moved.php'),
    );
    await f.engine.sync();
    expect(op.state).toBe('VERIFIED');
    expect(f.engine.store.state.files['moved.php'].baseline).toBeTruthy();
  });
  it('does not recreate the source of a pending directory rename during reconciliation', async () => {
    await remoteWrite(f, 'tree/a', 'a');
    await f.engine.sync();
    f.engine.paused = true;
    await fs.rename(path.join(f.local, 'tree'), path.join(f.local, 'moved'));
    await f.engine.rename('tree', 'moved');
    await f.engine.sync();
    await expect(fs.access(path.join(f.local, 'tree'))).rejects.toThrow();
    f.engine.paused = false;
    await f.engine.drain();
    expect(await fs.readFile(path.join(f.remote.root, 'moved/a'), 'utf8')).toBe(
      'a',
    );
  });
  it('detects local edits made while a remote download is in progress', async () => {
    await initial();
    await remoteWrite(f, 'index.php', 'remote');
    const original = f.remote.download.bind(f.remote);
    f.remote.download = async (remote, local, context) => {
      await original(remote, local, context);
      await localWrite(f, 'index.php', 'external edit during download');
    };
    await f.engine.sync();
    expect(await fs.readFile(path.join(f.local, 'index.php'), 'utf8')).toBe(
      'external edit during download',
    );
    expect(f.engine.store.state.files['index.php'].state).toBe('CONFLICT');
  });
  it('does not recreate a materialized directory pending deletion while paused', async () => {
    await fs.mkdir(path.join(f.remote.root, 'empty'));
    await f.engine.materialize('empty');
    f.engine.paused = true;
    await fs.rmdir(path.join(f.local, 'empty'));
    await f.engine.localChange('empty', 'rmdir');
    await f.engine.sync();
    await expect(fs.access(path.join(f.local, 'empty'))).rejects.toThrow();
    f.engine.paused = false;
    await f.engine.drain();
    await expect(
      fs.access(path.join(f.remote.root, 'empty')),
    ).rejects.toThrow();
  });
  it('follows Git history across a verified native rename and restores original bytes', async () => {
    await initial();
    const commit = (await f.engine.history.log('index.php'))
      .trim()
      .split(' ')[0];
    await fs.rename(
      path.join(f.local, 'index.php'),
      path.join(f.local, 'moved.php'),
    );
    await f.engine.rename('index.php', 'moved.php');
    expect(await f.engine.history.log('moved.php')).toContain('INITIAL_REMOTE');
    const restored = path.join(f.root, 'original');
    await f.engine.history.version(commit, 'moved.php', restored);
    expect(await fs.readFile(restored, 'utf8')).toBe('<?php echo 1;');
  });
  it('inspects remote changes without downloading over local files or publishing a pending queue', async () => {
    await initial();
    f.engine.paused = true;
    await localWrite(f, 'index.php', 'local pending');
    await f.engine.localChange('index.php');
    await remoteWrite(f, 'index.php', 'remote changed');
    const baseline = f.engine.store.state.files['index.php'].baseline;
    const operation = f.engine.store.state.operations.at(-1)!;
    const result = await f.engine.inspectFile('index.php');
    expect(result.local).not.toBe(result.remote);
    expect(result.baseline).toBe(baseline);
    expect(await fs.readFile(path.join(f.local, 'index.php'), 'utf8')).toBe(
      'local pending',
    );
    expect(
      await fs.readFile(path.join(f.remote.root, 'index.php'), 'utf8'),
    ).toBe('remote changed');
    expect(operation.state).toBe('PENDING');
    expect(f.remote.uploads).toBe(0);
    expect(f.engine.store.state.files['index.php'].baseline).toBe(baseline);
  });
});
