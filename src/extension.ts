import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Connections } from './connections';
import { ConnectionManager, FtpAdapter, SftpAdapter } from './adapters';
import { Connection, Credentials, State, SyncError, terminal } from './types';
import { SyncEngine } from './engine';
import { LocalWatcher } from './watcher';
import { WorkspaceView } from './ui';
import { ConnectionsView } from './connection-view';
import { localPath, relativePath } from './safety';
import { mergeCandidate } from './conflicts';
import { ActiveFileIndicator } from './active-file';
import { splitPhpHtml } from './split-editor';
import { configureBrowser } from './browser';
import { browserFileUrl } from './browser-url';

let shutdown: (() => Promise<void>) | undefined;
export interface TestApi {
  configure(c: Connection, credentials: Credentials): Promise<void>;
  state(): State | undefined;
  close(): Promise<void>;
  views(): { compact: string[]; connections: string[]; sections: string[] };
  fileStatus(): string;
  browserUrls(): string[];
}
export async function activate(
  context: vscode.ExtensionContext,
): Promise<TestApi | undefined> {
  const connections = new Connections(context);
  const browserUrls: string[] = [];
  const openBrowserUrl = async (url: string): Promise<boolean> => {
    if (context.extensionMode === vscode.ExtensionMode.Test) {
      browserUrls.push(url);
      return true;
    }
    return vscode.env.openExternal(vscode.Uri.parse(url));
  };
  const output = vscode.window.createOutputChannel('Remote Sync Workspace');
  const view = new WorkspaceView();
  const fileIndicator = new ActiveFileIndicator(() => view.engine);
  const connectionsView = new ConnectionsView(
    () => connections.all(),
    () => view.engine,
  );
  context.subscriptions.push(
    output,
    view,
    fileIndicator,
    connectionsView,
    vscode.window.registerTreeDataProvider(
      'remoteSync.connectionsView',
      connectionsView,
    ),
    view.onDidChangeTreeData(() => {
      connectionsView.update();
      fileIndicator.refresh();
      void vscode.commands.executeCommand(
        'setContext',
        'remoteSync.hasConnections',
        connections.all().length > 0,
      );
    }),
    vscode.window.registerTreeDataProvider('remoteSync.status', view),
    vscode.window.registerFileDecorationProvider(view),
  );
  let engine: SyncEngine | undefined;
  let watcher: LocalWatcher | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const log = (message: string): void => {
    if (
      vscode.workspace.getConfiguration('remoteSync').get('logLevel') !==
        'error' ||
      /CONFLICT|FAILED|UNCERTAIN|Error/i.test(message)
    )
      output.appendLine(`${new Date().toISOString()} ${message}`);
  };
  const fail = (e: unknown): void => {
    // Library errors can include authentication strings; never print arbitrary errors.
    const message =
      e instanceof SyncError
        ? e.message
        : 'Operation failed. Check connection settings, local permissions, Git installation and diagnostics.';
    log(`Error: ${message}`);
    void vscode.window
      .showErrorMessage(`Remote Sync: ${message}`, 'Diagnostics')
      .then((action) => {
        if (action)
          void vscode.commands.executeCommand('remoteSync.operations');
      });
  };
  const confirm = async (message: string): Promise<boolean> =>
    (await vscode.window.showWarningMessage(
      message,
      { modal: true },
      'Continue',
    )) === 'Continue';
  const stop = async (): Promise<void> => {
    clearInterval(poll);
    await watcher?.close();
    watcher = undefined;
    await engine?.close();
    engine = undefined;
    view.engine = undefined;
    view.update();
    await vscode.commands.executeCommand(
      'setContext',
      'remoteSync.active',
      false,
    );
  };
  shutdown = stop;
  const manager = async (c: Connection): Promise<ConnectionManager> => {
    const credentials = await connections.credentials(c.id);
    return new ConnectionManager(
      () =>
        c.protocol === 'sftp'
          ? new SftpAdapter(c, credentials)
          : new FtpAdapter(c, credentials),
      c.retryAttempts,
      () => view.update(),
    );
  };
  const progress = async (
    title: string,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (p, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() =>
          controller.abort(),
        );
        const old = engine?.hooks.report;
        if (engine)
          engine.hooks.report = (message) => {
            old?.(message);
            p.report({ message });
          };
        try {
          await work(controller.signal);
        } finally {
          subscription.dispose();
          if (engine && old) engine.hooks.report = old;
        }
      },
    );
  };
  const begin = async (c: Connection): Promise<void> => {
    if (!vscode.workspace.isTrusted)
      throw new SyncError('SAFETY', 'Trust this workspace before connecting');
    connections.validate(c);
    await stop();
    engine = new SyncEngine(
      c,
      path.join(context.globalStorageUri.fsPath, 'state', c.id),
      await manager(c),
      {
        dirty: (p) =>
          vscode.workspace.textDocuments.some(
            (d) =>
              d.isDirty &&
              path.resolve(d.uri.fsPath) === path.resolve(c.localRoot, p),
          ),
        changed: () => view.update(),
        report: log,
        confirm,
        notifyConflict: (p, message) => {
          void vscode.window
            .showWarningMessage(
              `Remote Sync conflict: ${p}. ${message}`,
              'Resolve',
            )
            .then((action) => {
              if (action)
                void vscode.commands.executeCommand(
                  'remoteSync.resolve',
                  vscode.Uri.file(path.join(c.localRoot, p)),
                );
            });
        },
      },
    );
    try {
      await engine.open();
    } catch (e) {
      engine = undefined;
      view.engine = undefined;
      view.update();
      throw e;
    }
    view.engine = engine;
    view.update();
    try {
      await progress(`Remote Sync: ${c.name}`, (signal) =>
        c.lazyLoading
          ? engine!.sync(signal)
          : engine!
              .materialize('', true, signal)
              .then(() => engine!.sync(signal)),
      );
    } catch (e) {
      fail(e);
    } // Keep the real local workspace and queue usable while offline.
  };
  const watch = (): void => {
    if (!engine) return;
    watcher = new LocalWatcher(engine, fail);
    watcher.start();
    if (engine.config.remotePollingMinutes)
      poll = setInterval(() => {
        if (!engine || polling) return;
        polling = true;
        void engine
          .sync()
          .catch(fail)
          .finally(() => {
            polling = false;
          });
      }, engine.config.remotePollingMinutes * 60000);
    void vscode.commands.executeCommand(
      'setContext',
      'remoteSync.active',
      true,
    );
  };
  const active = (): SyncEngine => {
    if (!engine)
      throw new SyncError('SAFETY', 'Open a Remote Sync connection first');
    return engine;
  };
  const selectPath = async (uri?: vscode.Uri): Promise<string | undefined> => {
    const current = active();
    const chosen = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (chosen?.scheme === 'file') {
      const rel = path
        .relative(current.config.localRoot, chosen.fsPath)
        .split(path.sep)
        .join('/');
      relativePath(rel, true);
      return rel;
    }
    return vscode.window.showQuickPick(Object.keys(current.store.state.files), {
      title: 'Choose a file',
    });
  };
  const register = (
    id: string,
    action: (...args: unknown[]) => Promise<unknown>,
  ): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `remoteSync.${id}`,
        (...args: unknown[]) => action(...args).catch(fail),
      ),
    );
  };
  register('add', async () => {
    await connections.add();
    view.update();
  });
  register('refreshConnections', async () => {
    view.update();
  });
  register('connections', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.remoteSync');
  });
  register('splitPhpHtml', async (uri) =>
    splitPhpHtml(uri instanceof vscode.Uri ? uri : undefined),
  );
  register('checkActiveFile', async () => fileIndicator.check());
  for (const state of [
    'synced',
    'local',
    'remote',
    'conflict',
    'different',
    'checking',
    'unknown',
    'error',
  ])
    register(`fileStatus.${state}`, async () => fileIndicator.check());
  const chosenConnection = async (
    id?: unknown,
  ): Promise<Connection | undefined> => {
    const connectionId =
      typeof id === 'string'
        ? id
        : id &&
            typeof id === 'object' &&
            'connectionId' in id &&
            typeof id.connectionId === 'string'
          ? id.connectionId
          : undefined;
    return connectionId
      ? connections.all().find((c) => c.id === connectionId)
      : (engine?.config ?? connections.select());
  };
  register('open', async (id) => {
    const c = await chosenConnection(id);
    if (!c) return;
    await begin(c);
    if (
      vscode.workspace.workspaceFolders?.some(
        (f) => path.resolve(f.uri.fsPath) === path.resolve(c.localRoot),
      )
    )
      watch();
    else {
      await stop();
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(c.localRoot),
        { forceNewWindow: false },
      );
    }
  });
  register('browserSettings', async (id) => {
    const c = await chosenConnection(id);
    if (!c) return;
    if (await configureBrowser(c, (next) => connections.save(next)))
      view.update();
  });
  register('openInBrowser', async (uri) => {
    const current = active();
    const file = await selectPath(uri instanceof vscode.Uri ? uri : undefined);
    if (!file) return;
    if (!current.config.webBaseUrl) {
      if (
        !(await configureBrowser(current.config, (next) =>
          connections.save(next),
        ))
      )
        return;
      view.update();
      if (!current.config.webBaseUrl) return;
    }
    const url = browserFileUrl(
      current.config.webBaseUrl,
      current.config.webRoot ?? '',
      file,
    );
    const document = vscode.workspace.textDocuments.find(
      (d) =>
        d.uri.fsPath ===
        path.join(current.config.localRoot, ...file.split('/')),
    );
    if (
      document?.isDirty ||
      current.store.state.files[file]?.state !== 'SYNCED' ||
      ['local', 'conflict'].includes(fileIndicator.state)
    )
      void vscode.window.showInformationMessage(
        'Apro la versione pubblicata sul server. Le modifiche locali non vengono salvate o caricate dal pulsante browser.',
      );
    if (!(await openBrowserUrl(url)))
      throw new SyncError(
        'SAFETY',
        'Il sistema non è riuscito ad aprire il browser predefinito.',
      );
  });
  register('edit', async (id) => {
    const c = await chosenConnection(id);
    if (!c) return;
    if (engine?.config.id === c.id) await stop();
    await connections.edit(c);
    view.update();
  });
  register('settings', async () =>
    vscode.commands.executeCommand('remoteSync.edit'),
  );
  register('remove', async (id) => {
    const c = await chosenConnection(id);
    if (c) {
      if (engine?.config.id === c.id) await stop();
      await connections.remove(c);
      view.update();
    }
  });
  register('test', async (id) => {
    const c = await chosenConnection(id);
    if (!c) return;
    connections.validate(c);
    const connection = await manager(c);
    try {
      await progress('Testing connection', async (signal) => {
        const adapter = await connection.get();
        await adapter.list(c.remoteRoot, { signal });
      });
      await vscode.window.showInformationMessage(
        `Remote Sync: ${c.name} connected; root listing succeeded.`,
      );
    } finally {
      await connection.invalidate();
    }
  });
  register('sync', async () => {
    const current = active();
    await progress('Reconciling remote content', (signal) =>
      current.sync(signal, true),
    );
  });
  register('pause', async () => {
    const current = active();
    current.paused = !current.paused;
    view.update();
    if (!current.paused) {
      current.config.autoUpload = true;
      await current.drain();
    }
  });
  for (const command of ['download', 'recursive', 'entire'])
    register(command, async (uri) => {
      const current = active();
      let p =
        command === 'entire'
          ? ''
          : await selectPath(uri instanceof vscode.Uri ? uri : undefined);
      if (p === undefined)
        p = await vscode.window.showQuickPick(
          Object.keys(current.store.state.directories),
          { title: 'Choose a directory' },
        );
      if (p === undefined) return;
      await progress('Downloading directory', (signal) =>
        current.materialize(p, command !== 'download', signal),
      );
    });
  register('retry', async () => active().retryFailed());
  register('recover', async () => {
    const current = active();
    const selected = await vscode.window.showQuickPick(
      current.store.state.operations
        .filter((o) => !terminal(o.state))
        .map((o) => ({
          label: `${o.state} ${o.type} ${o.path}`,
          description: o.error,
          op: o,
        })),
      { title: 'Recover blocked operation' },
    );
    if (!selected) return;
    const action = await vscode.window.showQuickPick(
      [
        'Reconcile / Retry Structural Operation',
        'Abandon Operation and Reconcile Manually',
      ],
      { title: selected.label },
    );
    if (action)
      await current.recoverOperation(
        selected.op.id,
        action.startsWith('Abandon'),
      );
  });
  register('logs', async () => output.show());
  register('operations', async () => {
    const current = active();
    const report = {
      connection: {
        id: current.config.id,
        name: current.config.name,
        protocol: current.config.protocol,
        status: current.connection.status,
      },
      lastSync: current.store.state.lastSync,
      queue: current.store.state.operations,
      files: current.store.state.files,
      directories: current.store.state.directories,
    };
    const doc = await vscode.workspace.openTextDocument({
      content: JSON.stringify(report, null, 2),
      language: 'json',
    });
    await vscode.window.showTextDocument(doc);
  });
  register('compare', async (uri) => {
    const current = active();
    const p = await selectPath(uri instanceof vscode.Uri ? uri : undefined);
    if (!p) return;
    const versions = await current.conflictVersions(p);
    if (!versions.remote)
      throw new SyncError(
        'SAFETY',
        'Remote version is absent; inspect conflict diagnostics',
      );
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(versions.remote),
      vscode.Uri.file(versions.local),
      `${p}: Remote ↔ Local`,
    );
  });
  register('merge', async (uri) => {
    const current = active();
    const p = await selectPath(uri instanceof vscode.Uri ? uri : undefined);
    if (!p) return;
    const versions = await current.conflictVersions(p);
    if (!versions.remote || !versions.baseline)
      throw new SyncError(
        'SAFETY',
        'A three way merge requires remote and common baseline versions',
      );
    const candidate = path.join(
      current.store.directory,
      `merge-${randomUUID()}${path.extname(p)}`,
    );
    await mergeCandidate(
      versions.local,
      versions.baseline,
      versions.remote,
      candidate,
    );
    await vscode.window.showTextDocument(vscode.Uri.file(candidate));
    const action = await vscode.window.showInformationMessage(
      'Review and save this three way merge candidate, then apply it locally. Publishing requires a separate Keep Local & Upload choice.',
      'Apply Saved Candidate',
    );
    if (action) {
      if (
        vscode.workspace.textDocuments.some(
          (d) => d.uri.fsPath === candidate && d.isDirty,
        )
      )
        throw new SyncError('SAFETY', 'Save the candidate before applying');
      if (
        /^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m.test(
          await fs.readFile(candidate, 'utf8'),
        )
      )
        throw new SyncError(
          'SAFETY',
          'Resolve all conflict markers before applying',
        );
      await current.restore(p, candidate);
    }
  });
  register('resolve', async (uri) => {
    const current = active();
    const p =
      uri instanceof vscode.Uri
        ? await selectPath(uri)
        : await vscode.window.showQuickPick(
            Object.entries(current.store.state.files)
              .filter(([, r]) => r.state === 'CONFLICT' || r.state === 'ERROR')
              .map(([p]) => p),
            { title: 'Choose conflict / uncertain file' },
          );
    if (!p) return;
    const action = await vscode.window.showQuickPick(
      ['Compare', 'Open Three Way Merge', 'Keep Remote', 'Keep Local & Upload'],
      { title: `Resolve ${p} — baseline in local content history` },
    );
    if (action === 'Compare')
      await vscode.commands.executeCommand(
        'remoteSync.compare',
        vscode.Uri.file(path.join(current.config.localRoot, p)),
      );
    else if (action === 'Open Three Way Merge')
      await vscode.commands.executeCommand(
        'remoteSync.merge',
        vscode.Uri.file(path.join(current.config.localRoot, p)),
      );
    else if (action)
      await current.resolve(p, action === 'Keep Remote' ? 'remote' : 'local');
  });
  register('history', async (uri) => {
    const current = active();
    let p = await selectPath(uri instanceof vscode.Uri ? uri : undefined);
    if (!p)
      p = await vscode.window.showInputBox({
        title: 'Relative file path (including deleted files)',
      });
    if (!p) return;
    relativePath(p);
    const lines = (await current.history.log(p))
      .trim()
      .split('\n')
      .filter(Boolean);
    const selected = await vscode.window.showQuickPick(
      lines.map((line) => ({
        label: line.slice(41),
        description: line.slice(0, 10),
        commit: line.slice(0, 40),
      })),
      { title: `History: ${p}` },
    );
    if (!selected) return;
    const temp = path.join(
      current.store.directory,
      `history-${randomUUID()}${path.extname(p)}`,
    );
    await current.history.version(selected.commit, p, temp);
    const action = await vscode.window.showQuickPick(
      ['Compare / Show Diff', 'View Version', 'Restore Version'],
      { title: 'History action' },
    );
    const target = await localPath(current.config.localRoot, p);
    if (action === 'Compare / Show Diff')
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(temp),
        vscode.Uri.file(target),
        `${p}: History ↔ Local`,
      );
    else if (action === 'View Version')
      await vscode.window.showTextDocument(vscode.Uri.file(temp));
    else if (
      action &&
      (await confirm(
        `Restore ${p}? Current saved content will be preserved. Restore is a new local change.`,
      ))
    ) {
      await current.restore(p, temp);
    }
  });
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (engine && doc.uri.scheme === 'file') {
        const rel = path
          .relative(engine.config.localRoot, doc.uri.fsPath)
          .split(path.sep)
          .join('/');
        if (rel && !rel.startsWith('../') && !path.isAbsolute(rel))
          watcher?.schedule(rel);
      }
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onWillRenameFiles((event) => {
      if (!engine) return;
      const paths = event.files
        .flatMap((f) => [f.oldUri, f.newUri])
        .map((u) =>
          path
            .relative(engine!.config.localRoot, u.fsPath)
            .split(path.sep)
            .join('/'),
        )
        .filter((p) => p && !p.startsWith('../') && !path.isAbsolute(p));
      watcher?.hold(paths);
      event.waitUntil(
        engine.preserve(paths.filter((_, i) => i % 2 === 0)).catch(fail),
      );
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onWillDeleteFiles((event) => {
      if (!engine) return;
      const paths = event.files
        .map((u) =>
          path
            .relative(engine!.config.localRoot, u.fsPath)
            .split(path.sep)
            .join('/'),
        )
        .filter((p) => p && !p.startsWith('../') && !path.isAbsolute(p));
      watcher?.hold(paths);
      event.waitUntil(engine.preserve(paths).catch(fail));
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidDeleteFiles((event) => {
      if (!engine) return;
      const paths = event.files
        .map((u) =>
          path
            .relative(engine!.config.localRoot, u.fsPath)
            .split(path.sep)
            .join('/'),
        )
        .filter((p) => p && !p.startsWith('../') && !path.isAbsolute(p));
      const held = watcher;
      void engine
        .deleteLocal(paths)
        .catch(fail)
        .finally(() => held?.release(paths));
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((event) => {
      if (!engine) return;
      for (const file of event.files) {
        const from = path
          .relative(engine.config.localRoot, file.oldUri.fsPath)
          .split(path.sep)
          .join('/');
        const to = path
          .relative(engine.config.localRoot, file.newUri.fsPath)
          .split(path.sep)
          .join('/');
        if (
          [from, to].some(
            (p) => !p || p.startsWith('../') || path.isAbsolute(p),
          )
        ) {
          fail(
            new SyncError(
              'SAFETY',
              'Cross-workspace moves require manual reconciliation',
            ),
          );
          continue;
        }
        const held = watcher;
        void engine
          .rename(from, to)
          .catch(fail)
          .finally(() => held?.release([from, to]));
      }
    }),
  );
  view.update();
  const current = connections
    .all()
    .find((c) =>
      vscode.workspace.workspaceFolders?.some(
        (f) => path.resolve(f.uri.fsPath) === path.resolve(c.localRoot),
      ),
    );
  if (current && vscode.workspace.isTrusted) {
    try {
      await begin(current);
      watch();
    } catch (e) {
      fail(e);
      if (engine?.store.state) watch();
    }
  }
  if (context.extensionMode === vscode.ExtensionMode.Test)
    return {
      configure: async (c, credentials) => {
        connections.validate(c);
        await connections.save(c);
        if (credentials.password)
          await context.secrets.store(`${c.id}.password`, credentials.password);
        view.update();
      },
      state: () => engine?.store.state,
      fileStatus: () => fileIndicator.state,
      browserUrls: () => [...browserUrls],
      views: () => ({
        compact: view.getChildren().map((item) => String(item.label)),
        connections: connectionsView
          .getChildren()
          .map((item) => String(item.label)),
        sections: connectionsView
          .getChildren()
          .flatMap((item) =>
            connectionsView
              .getChildren(item)
              .map((section) => String(section.label)),
          ),
      }),
      close: stop,
    };
}
export async function deactivate(): Promise<void> {
  await shutdown?.();
}
