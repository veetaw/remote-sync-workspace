import * as vscode from 'vscode';
import path from 'node:path';
import { SyncEngine } from './engine';
import { terminal } from './types';

export class WorkspaceView
  implements
    vscode.TreeDataProvider<vscode.TreeItem>,
    vscode.FileDecorationProvider,
    vscode.Disposable
{
  private treeEmitter = new vscode.EventEmitter<void>();
  private decorationEmitter = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeTreeData = this.treeEmitter.event;
  readonly onDidChangeFileDecorations = this.decorationEmitter.event;
  private status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    20,
  );
  engine?: SyncEngine;
  constructor() {
    this.status.command = 'remoteSync.operations';
    this.status.show();
  }
  update(): void {
    this.treeEmitter.fire();
    this.decorationEmitter.fire(undefined);
    const engine = this.engine;
    const pending =
      engine?.store.state?.operations.filter((o) => !terminal(o.state))
        .length ?? 0;
    this.status.text = engine
      ? `$(cloud) ${engine.config.name}: ${engine.paused ? 'Paused' : engine.connection.status} · ${pending}`
      : '$(server) Remote Sync';
    this.status.command = engine
      ? 'remoteSync.operations'
      : 'workbench.view.extension.remoteSync';
    this.status.tooltip =
      'Remote Sync Workspace — click for operations and diagnostics';
  }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }
  getChildren(): vscode.TreeItem[] {
    const engine = this.engine;
    if (!engine) return [];
    const state = engine.store.state;
    const operations = state?.operations ?? [];
    return [
      [
        engine.config.name,
        `${engine.config.protocol.toUpperCase()} · ${engine.connection.status}`,
        'remoteSync.settings',
      ],
      [
        'Activity',
        `${operations.filter((o) => !terminal(o.state)).length} queued · ${operations.filter((o) => o.state === 'FAILED' || o.state === 'UNCERTAIN').length} errors · ${Object.values(state?.files ?? {}).filter((r) => r.state === 'CONFLICT').length} conflicts`,
        'remoteSync.operations',
      ],
    ].map(([label, description, command]) => {
      const item = new vscode.TreeItem(label);
      item.description = description;
      item.command = { command, title: label };
      item.tooltip = `${label}: ${description}\nUploads: ${engine.paused ? 'Paused' : engine.config.autoUpload ? 'Automatic' : 'Manual'}\nLast sync: ${state?.lastSync ? new Date(state.lastSync).toLocaleString() : 'Not yet'}`;
      return item;
    });
  }
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const engine = this.engine;
    if (
      !engine ||
      !vscode.workspace
        .getConfiguration('remoteSync')
        .get('showDecorations', true) ||
      uri.scheme !== 'file'
    )
      return;
    const rel = path
      .relative(engine.config.localRoot, uri.fsPath)
      .split(path.sep)
      .join('/');
    if (rel.startsWith('../') || path.isAbsolute(rel)) return;
    const lazy = engine.store.state?.directories[rel];
    if (lazy && lazy !== 'MATERIALIZED')
      return {
        badge: lazy === 'ERROR' ? '!' : '↓',
        tooltip: `${lazy}: use Remote Sync: Download Directory from the context menu`,
        color: new vscode.ThemeColor('descriptionForeground'),
      };
    const state =
      engine.transfers.get(rel) ?? engine.store.state?.files[rel]?.state;
    if (!state) return;
    if (state === 'SYNCED' && engine.connection.status === 'ONLINE') return;
    const states: Record<string, [string, string]> = {
      PENDING: ['↑', 'Pending upload'],
      UPLOADING: ['↑', 'Uploading; awaiting content verification'],
      DOWNLOADING: ['↓', 'Downloading'],
      ERROR: ['!', 'Error or uncertain remote state — inspect operations'],
      CONFLICT: ['C', 'Conflict: local / remote / baseline available'],
      REMOTE_ONLY: ['↓', 'Not downloaded'],
      OFFLINE: ['○', 'Offline'],
      SYNCED: ['○', 'Offline: last known baseline only'],
    };
    const [badge, tooltip] = states[state];
    return {
      badge,
      tooltip,
      color: new vscode.ThemeColor(
        state === 'CONFLICT' || state === 'ERROR'
          ? 'errorForeground'
          : 'descriptionForeground',
      ),
    };
  }
  dispose(): void {
    this.status.dispose();
    this.treeEmitter.dispose();
    this.decorationEmitter.dispose();
  }
}
