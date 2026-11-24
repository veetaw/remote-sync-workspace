import * as vscode from 'vscode';
import { SyncEngine } from './engine';
import { Connection, terminal } from './types';

export class ConnectionItem extends vscode.TreeItem {
  constructor(
    label: string,
    readonly connectionId?: string,
    readonly section?: string,
  ) {
    super(label);
  }
}

export class ConnectionsView
  implements vscode.TreeDataProvider<ConnectionItem>, vscode.Disposable
{
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(
    private configs: () => Connection[],
    private active: () => SyncEngine | undefined,
  ) {}
  update(): void {
    this.emitter.fire();
  }
  getTreeItem(item: ConnectionItem): ConnectionItem {
    return item;
  }
  getChildren(parent?: ConnectionItem): ConnectionItem[] {
    const engine = this.active();
    if (!parent)
      return this.configs().map((c) => {
        const current = engine?.config.id === c.id;
        const item = new ConnectionItem(c.name, c.id);
        item.id = c.id;
        item.collapsibleState = current
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
        item.contextValue = 'remoteSync.connection';
        item.description = `${c.protocol.toUpperCase()} · ${current ? engine.connection.status : 'Disconnected'}${current ? ' · Current' : ''}`;
        item.iconPath = new vscode.ThemeIcon(current ? 'plug' : 'server');
        item.tooltip = `${c.name}\n${c.protocol.toUpperCase()}://${c.host}:${c.port}${c.remoteRoot}\nLocal: ${c.localRoot}`;
        item.accessibilityInformation = {
          label: `${c.name}, ${item.description}`,
        };
        return item;
      });
    const c = this.configs().find((c) => c.id === parent.connectionId);
    if (!c) return [];
    const current = engine?.config.id === c.id ? engine : undefined;
    const row = (
      label: string,
      description: string,
      command?: string,
      icon?: string,
    ): ConnectionItem => {
      const item = new ConnectionItem(label, c.id);
      item.description = description;
      item.tooltip = `${label}: ${description}`;
      if (command)
        item.command = {
          command: `remoteSync.${command}`,
          title: label,
          arguments: [c.id],
        };
      if (icon) item.iconPath = new vscode.ThemeIcon(icon);
      return item;
    };
    if (!parent.section)
      return [
        'Server',
        'Local workspace',
        'Synchronization',
        ...(current ? ['Current activity'] : []),
        'Actions',
      ].map((section) => {
        const item = new ConnectionItem(section, c.id, section);
        item.id = `${c.id}/${section}`;
        item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        return item;
      });
    switch (parent.section) {
      case 'Server':
        return [
          row('Protocol', c.protocol.toUpperCase()),
          row('Host', c.host),
          row('Port', String(c.port)),
          row('Username', c.username),
          row('Remote root', c.remoteRoot),
          row(
            'Website URL',
            c.webBaseUrl || 'Not configured',
            'browserSettings',
            'globe',
          ),
          row(
            'Web document root',
            c.webRoot || 'Project root',
            'browserSettings',
          ),
          ...(c.protocol === 'sftp'
            ? [
                row(
                  'Authentication',
                  c.privateKeyPath ? 'SSH private key' : 'Password',
                ),
                row(
                  'Host key',
                  c.hostKey ? 'Pinned SHA-256 fingerprint' : 'Not configured',
                ),
              ]
            : []),
        ];
      case 'Local workspace':
        return [
          row('Directory', c.localRoot),
          row('Connection ID', c.id),
          row('History', 'Private local Git'),
          row('Lazy loading', c.lazyLoading ? 'Enabled' : 'Disabled'),
        ];
      case 'Synchronization':
        return [
          row('Auto upload', c.autoUpload ? 'Enabled' : 'Disabled'),
          row(
            'Remote polling',
            c.remotePollingMinutes
              ? `Every ${c.remotePollingMinutes} minutes`
              : 'Disabled',
          ),
          row('Excluded patterns', c.excludes.join(', ') || 'None'),
          row('Timeout', `${c.timeout / 1000} seconds`),
          row('Retries', String(c.retryAttempts)),
          row('Confirm rename', c.confirmRename ? 'Yes' : 'No'),
          row('Confirm deletion', c.confirmMassDelete ? 'Yes' : 'No'),
        ];
      case 'Current activity': {
        if (!current) return [];
        const state = current.store.state;
        return [
          row('Connection', current.connection.status),
          row(
            'Uploads',
            current.paused ? 'Paused' : c.autoUpload ? 'Automatic' : 'Manual',
          ),
          row(
            'Queue',
            String(state.operations.filter((o) => !terminal(o.state)).length),
            'operations',
          ),
          row(
            'Errors / uncertain',
            String(
              state.operations.filter(
                (o) => o.state === 'FAILED' || o.state === 'UNCERTAIN',
              ).length,
            ),
            'operations',
          ),
          row(
            'Conflicts',
            String(
              Object.values(state.files).filter((f) => f.state === 'CONFLICT')
                .length,
            ),
            'resolve',
          ),
          row(
            'Last remote sync',
            state.lastSync
              ? new Date(state.lastSync).toLocaleString()
              : 'Not yet',
          ),
          row(
            'Operations and diagnostics',
            'Inspect queue',
            'operations',
            'list-unordered',
          ),
          row('Show log', 'Output channel', 'logs', 'output'),
        ];
      }
      case 'Actions':
        return [
          row('Connect / Open', 'Open local workspace', 'open', 'plug'),
          row('Test Connection', 'Verify server access', 'test', 'beaker'),
          row('Edit Connection', 'Settings and credentials', 'edit', 'edit'),
          row(
            'Delete Connection',
            'Keep local files and history',
            'remove',
            'trash',
          ),
          ...(current
            ? [
                row('Sync Now', 'Reconcile remote content', 'sync', 'sync'),
                row(
                  'Pause / Resume Upload',
                  'Control publishing',
                  'pause',
                  'debug-pause',
                ),
                row(
                  'Download Entire Project',
                  'Materialize for indexing',
                  'entire',
                  'cloud-download',
                ),
              ]
            : []),
        ];
      default:
        return [];
    }
  }
  dispose(): void {
    this.emitter.dispose();
  }
}
