import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net, { AddressInfo } from 'node:net';
import FtpServer from 'ftp-srv';
import { TestApi } from '../src/extension';
import { Connection } from '../src/types';
import { htmlStartOffset } from '../src/document-layout';

async function until(
  condition: () => Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(message);
}
export async function run(): Promise<void> {
  const root = process.env.RSW_TEST_ROOT!;
  const remote = path.join(root, 'remote');
  await fs.mkdir(path.join(remote, 'site', 'lib'), { recursive: true });
  await fs.writeFile(path.join(remote, 'site/index.php'), '<?php echo 1;');
  const layoutText =
    '<?php\n' +
    '// PHP section\n'.repeat(100) +
    '?>\n<!doctype html>\n<html lang="it">\n' +
    '<p>HTML section</p>\n'.repeat(100) +
    '</html>\n';
  await fs.writeFile(path.join(remote, 'site/layout.php'), layoutText);
  await fs.writeFile(
    path.join(remote, 'site/lib/module.php'),
    '<?php function example() {}',
  );
  const reservation = net.createServer();
  await new Promise<void>((r) => reservation.listen(0, '127.0.0.1', r));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((r) => reservation.close(() => r()));
  const quiet = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return this;
    },
  };
  const server = new FtpServer({
    url: `ftp://127.0.0.1:${port}`,
    log: quiet,
    pasv_url: '127.0.0.1',
  });
  server.on('login', ({ password }, resolve, reject) =>
    password === 'host-test-password'
      ? resolve({ root: remote })
      : reject(new Error('Authentication failed')),
  );
  await server.listen();
  const extension = vscode.extensions.getExtension<TestApi>(
    process.env.RSW_TEST_EXTENSION_ID!,
  );
  assert.ok(extension);
  const api = await extension.activate();
  assert.ok(api);
  assert.deepEqual(api.views().compact, []);
  const manifest = extension.packageJSON as {
    contributes: {
      viewsContainers: { activitybar: { id: string; icon: string }[] };
      views: { explorer: { id: string; when: string }[] };
    };
  };
  const container = manifest.contributes.viewsContainers.activitybar.find(
    (c) => c.id === 'remoteSync',
  );
  assert.ok(container);
  await fs.access(path.join(extension.extensionPath, container.icon));
  assert.equal(
    manifest.contributes.views.explorer.find(
      (v) => v.id === 'remoteSync.status',
    )?.when,
    'remoteSync.active',
  );
  const local = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const c: Connection = {
    id: 'host-fixture',
    name: 'Extension Host FTP',
    protocol: 'ftp',
    host: '127.0.0.1',
    port,
    username: 'tester',
    remoteRoot: '/site',
    localRoot: local,
    autoUpload: true,
    remotePollingMinutes: 0,
    lazyLoading: true,
    excludes: [],
    timeout: 2000,
    retryAttempts: 0,
    confirmRename: false,
    confirmMassDelete: false,
    webBaseUrl: 'https://example.test/demo/',
  };
  try {
    await api.configure(c, { password: 'host-test-password' });
    await api.configure(
      {
        ...c,
        id: 'other-fixture',
        name: 'Other saved connection',
        localRoot: path.join(root, 'other-workspace'),
      },
      {},
    );
    assert.deepEqual(api.views().compact, []);
    assert.equal(api.views().connections.length, 2);
    await vscode.commands.executeCommand('remoteSync.open', c.id);
    assert.equal(api.views().compact.length, 2);
    assert.ok(api.views().compact.includes(c.name));
    assert.ok(!api.views().compact.includes('Other saved connection'));
    assert.equal(api.views().connections.length, 2);
    for (const section of [
      'Server',
      'Local workspace',
      'Synchronization',
      'Current activity',
      'Actions',
    ])
      assert.ok(api.views().sections.includes(section));
    await vscode.commands.executeCommand('remoteSync.connections');
    assert.equal(
      await fs.readFile(path.join(local, 'index.php'), 'utf8'),
      '<?php echo 1;',
    );
    assert.equal(api.state()!.directories.lib, 'DISCOVERED');
    await vscode.commands.executeCommand(
      'remoteSync.download',
      vscode.Uri.file(path.join(local, 'lib')),
    );
    assert.ok(await fs.readFile(path.join(local, 'lib/module.php')));
    const layoutUri = vscode.Uri.file(path.join(local, 'layout.php'));
    const layoutDocument = await vscode.workspace.openTextDocument(layoutUri);
    await vscode.window.showTextDocument(layoutDocument, { preview: false });
    await until(async () => {
      await vscode.commands.executeCommand('remoteSync.checkActiveFile');
      return api.fileStatus() === 'synced';
    }, 'Current-file indicator did not verify matching content');
    await fs.writeFile(
      path.join(remote, 'site/layout.php'),
      layoutText + '<!-- remote change -->',
    );
    await until(async () => {
      await vscode.commands.executeCommand('remoteSync.checkActiveFile');
      return api.fileStatus() === 'remote';
    }, 'Current-file indicator did not detect remote divergence');
    assert.equal(layoutDocument.getText(), layoutText);
    const unsaved = new vscode.WorkspaceEdit();
    unsaved.insert(
      layoutUri,
      new vscode.Position(1, 0),
      '// Shared unsaved edit\n',
    );
    await vscode.workspace.applyEdit(unsaved);
    await until(
      async () => api.fileStatus() === 'conflict',
      'Dirty local buffer plus remote change was not indicated',
    );
    await vscode.commands.executeCommand('remoteSync.splitPhpHtml', layoutUri);
    const splitEditors = vscode.window.visibleTextEditors
      .filter((e) => e.document === layoutDocument)
      .sort((a, b) => (a.viewColumn ?? 1) - (b.viewColumn ?? 1));
    assert.equal(splitEditors.length, 2);
    assert.equal(splitEditors[0].selection.active.line, 0);
    assert.equal(
      splitEditors[1].selection.active.line,
      layoutDocument.positionAt(htmlStartOffset(layoutDocument.getText())!)
        .line,
    );
    assert.ok(
      splitEditors.every(
        (e) =>
          e.document.isDirty &&
          e.document.getText().includes('Shared unsaved edit'),
      ),
    );
    const queuedBeforeBrowser = api.state()!.operations.length;
    await vscode.commands.executeCommand('remoteSync.openInBrowser', layoutUri);
    assert.equal(
      api.browserUrls().at(-1),
      'https://example.test/demo/layout.php',
    );
    assert.ok(layoutDocument.isDirty);
    assert.equal(api.state()!.operations.length, queuedBeforeBrowser);
    await vscode.commands.executeCommand('remoteSync.splitPhpHtml', layoutUri);
    assert.equal(
      vscode.window.visibleTextEditors.filter(
        (e) => e.document === layoutDocument,
      ).length,
      2,
    );
    assert.equal(
      await fs.readFile(path.join(remote, 'site/layout.php'), 'utf8'),
      layoutText + '<!-- remote change -->',
    );
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await fs.writeFile(path.join(remote, 'site/layout.php'), layoutText);
    if (process.env.RSW_TEST_PHP) {
      const php = vscode.extensions.getExtension(
        'bmewburn.vscode-intelephense-client',
      );
      assert.ok(php);
      await php.activate();
      const module = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(local, 'lib/module.php')),
      );
      console.log(
        `PHP compatibility: language=${module.languageId}, Intelephense=${php.packageJSON.version}`,
      );
      assert.equal(module.languageId, 'php');
      await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider',
        module.uri,
      );
      const scratch = vscode.Uri.file(path.join(local, 'completion.php'));
      await fs.writeFile(scratch.fsPath, '<?php\nexam');
      const doc = await vscode.workspace.openTextDocument(scratch);
      await vscode.window.showTextDocument(doc);
      await until(async () => {
        const result =
          await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            scratch,
            new vscode.Position(1, 4),
          );
        return (
          result?.items.some((item) =>
            (typeof item.label === 'string'
              ? item.label
              : item.label.label
            ).startsWith('example'),
          ) ?? false
        );
      }, 'Intelephense did not index the materialized PHP function');
      console.log(
        'Intelephense compatibility: completion for downloaded PHP symbol passed',
      );
    }
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(local, 'index.php')),
    );
    await vscode.window.showTextDocument(document);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      document.uri,
      new vscode.Position(0, document.lineAt(0).text.length),
      '\n// Saved in actual Extension Host',
    );
    await vscode.workspace.applyEdit(edit);
    await document.save();
    await until(
      async () =>
        (
          await fs.readFile(path.join(remote, 'site/index.php'), 'utf8')
        ).includes('Saved in actual Extension Host'),
      'Save event did not upload',
    );
    await until(
      async () => api.state()!.files['index.php'].state === 'SYNCED',
      'Upload was not verified',
    );
    const rename = new vscode.WorkspaceEdit();
    rename.renameFile(
      document.uri,
      vscode.Uri.file(path.join(local, 'renamed.php')),
    );
    await vscode.workspace.applyEdit(rename);
    await until(async () => {
      try {
        return (
          await fs.readFile(path.join(remote, 'site/renamed.php'), 'utf8')
        ).includes('Saved');
      } catch {
        return false;
      }
    }, 'Native rename did not propagate');
    await fs.writeFile(
      path.join(remote, 'site/new.php'),
      '<?php echo "remote";',
    );
    await vscode.commands.executeCommand('remoteSync.sync');
    assert.equal(
      await fs.readFile(path.join(local, 'new.php'), 'utf8'),
      '<?php echo "remote";',
    );
    await fs.writeFile(path.join(local, 'new.php'), 'local divergence');
    await fs.writeFile(path.join(remote, 'site/new.php'), 'remote divergence');
    await vscode.commands.executeCommand('remoteSync.sync');
    assert.equal(api.state()!.files['new.php'].state, 'CONFLICT');
    await vscode.commands.executeCommand('remoteSync.operations');
    assert.ok(
      vscode.workspace.textDocuments.some(
        (d) =>
          d.languageId === 'json' &&
          d.getText().includes('remote divergence') === false &&
          d.getText().includes('CONFLICT'),
      ),
    );
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'remoteSync.entire',
      'remoteSync.history',
      'remoteSync.resolve',
      'remoteSync.test',
    ])
      assert.ok(commands.includes(command));
    const deletion = new vscode.WorkspaceEdit();
    deletion.deleteFile(vscode.Uri.file(path.join(local, 'renamed.php')));
    await vscode.workspace.applyEdit(deletion);
    await until(async () => {
      try {
        await fs.access(path.join(remote, 'site/renamed.php'));
        return false;
      } catch {
        return true;
      }
    }, 'Native delete did not propagate');
    await api.close();
    assert.deepEqual(api.views().compact, []);
    assert.equal(api.views().connections.length, 2);
    await fs.mkdir(process.env.RSW_REPORT_DIR!, { recursive: true });
    await fs.writeFile(
      path.join(
        process.env.RSW_REPORT_DIR!,
        process.env.RSW_TEST_PHP
          ? 'php-compatibility.json'
          : process.env.RSW_TEST_VSIX
            ? 'vsix-host.json'
            : 'extension-host.json',
      ),
      JSON.stringify(
        {
          passed: true,
          vscode: vscode.version,
          node: process.version,
          intelephense: vscode.extensions.getExtension(
            'bmewburn.vscode-intelephense-client',
          )?.packageJSON.version,
          checks: [
            'activation',
            'SecretStorage connection',
            'root materialization',
            'lazy context command',
            'native PHP document',
            'save auto upload',
            'post-upload verification',
            'native rename',
            'native delete',
            'manual sync',
            'conflict protection',
            'diagnostics',
            'command registration',
            'dedicated Activity Bar container and icon',
            'detailed connections view keeps all saved connections',
            'compact Explorer view shows current connection only',
            'Explorer view hidden without an active connection',
            'read-only active-file status detects remote change and dirty conflict',
            'PHP / HTML split shares the unsaved document and positions both views',
            'repeated PHP / HTML split reuses the existing second editor',
            'browser command maps the configured domain without saving or publishing',
            ...(process.env.RSW_TEST_PHP
              ? ['Intelephense cross-file symbol completion']
              : []),
          ],
        },
        null,
        2,
      ),
    );
    console.log('Extension Host: all checks passed');
  } finally {
    await api.close();
    await server.close();
  }
}
