const fs = require('node:fs');
const p = JSON.parse(fs.readFileSync('package.json'));
Object.assign(p, {
  name: 'remote-sync-workspace',
  displayName: 'Remote Sync Workspace',
  version: p.version,
  publisher: p.publisher,
  description:
    'Persistent local FTP, FTPS and SFTP workspaces with verified synchronization and recoverable history.',
  license: 'MIT',
  main: './dist/extension.js',
  engines: { vscode: '^1.110.0', node: '>=22' },
  categories: ['Other'],
  activationEvents: ['onStartupFinished'],
  capabilities: {
    untrustedWorkspaces: {
      supported: false,
      description:
        'Remote synchronization executes Git and publishes local files.',
    },
    virtualWorkspaces: false,
  },
});
delete p.directories;
p.scripts = {
  build: 'tsc --noEmit && node scripts/build.cjs',
  test: 'vitest run',
  'test:extension': 'npm run build && node scripts/test-extension.cjs',
  'test:php': 'npm run build && node scripts/test-extension.cjs --php',
  'test:vsix': 'node scripts/test-extension.cjs --vsix',
  lint: 'eslint src test',
  format: 'prettier --write src test docs *.md *.json',
  check: 'npm run build && npm run lint && npm test',
  package: 'vsce package --no-dependencies',
  'vscode:prepublish': 'npm run build && node scripts/notices.cjs',
};
const commands = {
  add: 'Add Connection',
  connections: 'Manage Connections',
  refreshConnections: 'Refresh Connections View',
  edit: 'Edit Connection',
  remove: 'Delete Connection',
  open: 'Connect / Open Workspace',
  test: 'Test Connection',
  sync: 'Sync Now',
  pause: 'Pause / Resume Upload',
  download: 'Download Directory / Refresh Directory',
  recursive: 'Download Recursively',
  entire: 'Download Entire Project for Indexing',
  operations: 'Operations and Diagnostics',
  recover: 'Recover / Abandon Blocked Operation',
  retry: 'Retry Failed Operations',
  resolve: 'Resolve Conflict',
  compare: 'Compare Local and Remote',
  merge: 'Open Three Way Merge',
  history: 'View History / Restore Version',
  settings: 'Connection Settings',
  logs: 'Show Log',
  splitPhpHtml: 'Split PHP / HTML in the Same File',
  checkActiveFile: 'Check Current File Against Server (Read Only)',
  openInBrowser: 'Open Published File in Browser',
  browserSettings: 'Configure Website URL / Web Root',
};
const icons = {
  add: 'add',
  sync: 'sync',
  pause: 'debug-pause',
  settings: 'gear',
  logs: 'output',
  connections: 'server',
  refreshConnections: 'refresh',
  open: 'plug',
  edit: 'edit',
  test: 'beaker',
  remove: 'trash',
  splitPhpHtml: 'layout-sidebar-right',
  checkActiveFile: 'circle-outline',
  openInBrowser: 'globe',
  browserSettings: 'globe',
};
p.contributes = {
  commands: Object.entries(commands).map(([id, title]) => ({
    command: `remoteSync.${id}`,
    title: `Remote Sync: ${title}`,
    ...(icons[id] ? { icon: `$(${icons[id]})` } : {}),
  })),
  viewsContainers: {
    activitybar: [
      {
        id: 'remoteSync',
        title: 'Remote Sync',
        icon: 'resources/remote-sync.svg',
      },
    ],
  },
  views: {
    remoteSync: [
      {
        id: 'remoteSync.connectionsView',
        name: 'Connections',
        contextualTitle: 'Remote Sync Connections',
      },
    ],
    explorer: [
      {
        id: 'remoteSync.status',
        name: 'Remote Sync',
        contextualTitle: 'Current Remote Connection',
        when: 'remoteSync.active',
      },
    ],
  },
  viewsWelcome: [
    {
      view: 'remoteSync.connectionsView',
      contents:
        'Manage FTP, FTPS and SFTP connections.\n[Add Connection](command:remoteSync.add)',
      when: '!remoteSync.hasConnections',
    },
  ],
  menus: {
    'editor/title': [
      {
        command: 'remoteSync.openInBrowser',
        when: 'remoteSync.active && resourceScheme == file',
        group: 'navigation@2',
      },
      {
        command: 'remoteSync.splitPhpHtml',
        when: 'resourceScheme == file && (resourceExtname == .php || resourceExtname == .phtml || resourceExtname == .html || resourceExtname == .htm || editorLangId == php)',
        group: 'navigation@1',
      },
    ],
    'view/title': [
      ...['sync', 'pause', 'settings'].map((id) => ({
        command: `remoteSync.${id}`,
        when: 'view == remoteSync.status && remoteSync.active',
        group: 'navigation',
      })),
      ...['add', 'refreshConnections'].map((id) => ({
        command: `remoteSync.${id}`,
        when: 'view == remoteSync.connectionsView',
        group: 'navigation',
      })),
    ],
    'view/item/context': ['open', 'test', 'edit', 'remove'].map(
      (id, index) => ({
        command: `remoteSync.${id}`,
        when: 'view == remoteSync.connectionsView && viewItem == remoteSync.connection',
        group: index < 3 ? `inline@${index}` : 'remoteSync',
      }),
    ),
    'explorer/context': [
      'download',
      'recursive',
      'compare',
      'resolve',
      'history',
    ].map((id) => ({
      command: `remoteSync.${id}`,
      when: 'remoteSync.active && resourceScheme == file',
      group: 'remoteSync',
    })),
  },
  configuration: { title: 'Remote Sync Workspace', properties: {} },
};
const settings = {
  activeFileCheckSeconds: [
    'number',
    15,
    'Read-only content check interval for the active remote-workspace file, independent of synchronization. Does not upload, delete or replace workspace files.',
  ],
  autoUpload: ['boolean', true, 'Automatically publish saved local changes.'],
  remotePollingMinutes: [
    'number',
    10,
    'Remote reconciliation interval; 0 disables polling.',
  ],
  lazyLoading: [
    'boolean',
    true,
    'Materialize only root files initially. Use the Explorer context command to load directories.',
  ],
  confirmRename: ['boolean', false, 'Confirm propagation of renames.'],
  confirmMassDelete: [
    'boolean',
    true,
    'Confirm remote directory removal and batches of file deletions.',
  ],
  retryAttempts: [
    'number',
    3,
    'Bounded connection attempts and explicitly requested safe retries.',
  ],
  showDecorations: [
    'boolean',
    true,
    'Show synchronization badges in the native Explorer.',
  ],
  logLevel: ['string', 'info', 'Output verbosity.'],
  excludes: [
    'array',
    ['**/node_modules/**', '**/.git/**'],
    'Excluded relative paths (glob patterns).',
  ],
  timeout: [
    'number',
    30000,
    'Protocol connection/operation timeout in milliseconds.',
  ],
};
for (const [name, [type, value, description]] of Object.entries(settings))
  p.contributes.configuration.properties[`remoteSync.${name}`] = {
    type,
    default: value,
    description,
    scope: 'machine',
    ...(name === 'remotePollingMinutes' ? { enum: [0, 5, 10, 15, 30] } : {}),
    ...(name === 'retryAttempts' ? { minimum: 0, maximum: 5 } : {}),
    ...(name === 'timeout' ? { minimum: 1000, maximum: 300000 } : {}),
    ...(name === 'activeFileCheckSeconds' ? { minimum: 5, maximum: 300 } : {}),
    ...(name === 'excludes' ? { items: { type: 'string' } } : {}),
    ...(name === 'logLevel' ? { enum: ['info', 'debug', 'error'] } : {}),
  };
const indicators = {
  synced: ['Allineato all’ultimo controllo', 'circle-filled'],
  local: ['Modifiche locali', 'circle-filled'],
  remote: ['Modifiche sul server', 'circle-filled'],
  conflict: ['Locale e server divergenti', 'warning'],
  different: ['Locale e server differenti', 'circle-filled'],
  checking: ['Controllo server in corso', 'sync~spin'],
  unknown: ['Server non verificato', 'circle-outline'],
  error: ['Controllo server non riuscito', 'circle-slash'],
};
for (const [state, [label, icon]] of Object.entries(indicators)) {
  const command = `remoteSync.fileStatus.${state}`;
  p.contributes.commands.push({
    command,
    title: `Remote Sync: ${label} — clic per ricontrollare`,
    icon: `$(${icon})`,
  });
  p.contributes.menus['editor/title'].push({
    command,
    when: `remoteSync.active && remoteSync.fileState == ${state} && resourceScheme == file`,
    group: 'navigation@0',
  });
}
p.contributes.menus.commandPalette = Object.keys(indicators).map((state) => ({
  command: `remoteSync.fileStatus.${state}`,
  when: 'false',
}));
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
