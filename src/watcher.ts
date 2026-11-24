import chokidar, { FSWatcher } from 'chokidar';
import path from 'node:path';
import { SyncEngine } from './engine';
import { excluded } from './safety';

export class LocalWatcher {
  private watcher?: FSWatcher;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private ignored = new Set<string>();
  private releases = new Set<ReturnType<typeof setTimeout>>();
  constructor(
    private engine: SyncEngine,
    private error: (e: unknown) => void,
  ) {}
  start(): void {
    const root = this.engine.config.localRoot;
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      followSymlinks: false,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
      ignored: (file) => {
        const rel = path.relative(root, file).split(path.sep).join('/');
        return !!rel && excluded(rel, this.engine.config.excludes);
      },
    });
    this.watcher
      .on('all', (event, file) => {
        const p = path.relative(root, file).split(path.sep).join('/');
        if (!p || excluded(p, this.engine.config.excludes)) return;
        this.schedule(
          p,
          event === 'addDir'
            ? 'directory'
            : event === 'unlinkDir'
              ? 'rmdir'
              : event === 'unlink'
                ? 'delete'
                : 'file',
        );
      })
      .on('error', this.error);
  }
  schedule(
    p: string,
    event: 'file' | 'directory' | 'delete' | 'rmdir' = 'file',
  ): void {
    if (this.stopped) return;
    if (
      [...this.ignored].some(
        (prefix) => p === prefix || p.startsWith(`${prefix}/`),
      )
    )
      return;
    clearTimeout(this.timers.get(p));
    this.timers.set(
      p,
      setTimeout(
        () => {
          this.timers.delete(p);
          void this.engine.localChange(p, event).catch(this.error);
        },
        event === 'rmdir' ? 900 : 450,
      ),
    );
  }
  hold(paths: string[]): void {
    for (const p of paths) {
      this.ignored.add(p);
      for (const [key, timer] of this.timers)
        if (key === p || key.startsWith(`${p}/`)) {
          clearTimeout(timer);
          this.timers.delete(key);
        }
    }
    // Native operations may be cancelled without a corresponding did-event.
    this.release(paths, 15000);
  }
  release(paths: string[], delay = 1200): void {
    const timer = setTimeout(() => {
      this.releases.delete(timer);
      for (const p of paths) this.ignored.delete(p);
      if (!this.stopped) void this.engine.scanLocalChanges().catch(this.error);
    }, delay);
    this.releases.add(timer);
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const timer of [...this.timers.values(), ...this.releases])
      clearTimeout(timer);
    this.timers.clear();
    this.releases.clear();
    await this.watcher?.close();
  }
}
