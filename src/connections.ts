import * as vscode from 'vscode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Connection, Credentials, Protocol } from './types';
import { remotePath, relativePath } from './safety';
import { browserBaseUrl } from './browser-url';

export class Connections {
  constructor(private context: vscode.ExtensionContext) {}
  all(): Connection[] {
    return this.context.globalState.get<Connection[]>('connections', []);
  }
  async save(config: Connection): Promise<void> {
    await this.context.globalState.update('connections', [
      ...this.all().filter((c) => c.id !== config.id),
      config,
    ]);
  }
  async credentials(id: string): Promise<Credentials> {
    return {
      password: await this.context.secrets.get(`${id}.password`),
      passphrase: await this.context.secrets.get(`${id}.passphrase`),
    };
  }
  async remove(c: Connection): Promise<void> {
    if (
      (await vscode.window.showWarningMessage(
        `Delete connection ${c.name}? Local workspace, queue and history will be retained.`,
        { modal: true },
        'Delete',
      )) !== 'Delete'
    )
      return;
    await this.context.globalState.update(
      'connections',
      this.all().filter((x) => x.id !== c.id),
    );
    await this.context.secrets.delete(`${c.id}.password`);
    await this.context.secrets.delete(`${c.id}.passphrase`);
  }
  async select(): Promise<Connection | undefined> {
    const picked = await vscode.window.showQuickPick(
      this.all().map((c) => ({
        label: c.name,
        description: `${c.protocol.toUpperCase()} ${c.host}:${c.port}`,
        config: c,
      })),
      { title: 'Remote Sync — Connections' },
    );
    return picked?.config;
  }
  private async input(
    title: string,
    value = '',
    secret = false,
  ): Promise<string> {
    const result = await vscode.window.showInputBox({
      title,
      value,
      password: secret,
      ignoreFocusOut: true,
    });
    if (result === undefined) throw new Error('CANCELLED');
    return result;
  }
  async add(): Promise<Connection | undefined> {
    try {
      const defaults = vscode.workspace.getConfiguration('remoteSync');
      const id = randomUUID();
      const name = await this.input('Connection name');
      const protocol = (await vscode.window.showQuickPick(
        ['ftp', 'ftps', 'sftp'],
        {
          title:
            'Protocol (FTP transmits credentials and content in plaintext)',
        },
      )) as Protocol | undefined;
      if (!protocol) return;
      const host = await this.input('Host / IP');
      const port = Number(
        await this.input('Port', protocol === 'sftp' ? '22' : '21'),
      );
      const username = await this.input('Username');
      const remoteRoot = await this.input('Absolute remote root (POSIX)', '/');
      const localRoot = await this.input(
        'Persistent local workspace (absolute path)',
        path.join(this.context.globalStorageUri.fsPath, 'workspaces', id),
      );
      const password = await this.input(
        'Password (optional; stored in SecretStorage)',
        '',
        true,
      );
      const privateKeyPath =
        protocol === 'sftp'
          ? await this.input('Private key absolute path (optional)')
          : undefined;
      const passphrase = privateKeyPath
        ? await this.input('Private key passphrase (optional)', '', true)
        : undefined;
      const hostKey =
        protocol === 'sftp'
          ? await this.input(
              'Trusted SSH host key: SHA-256 fingerprint as 64 hexadecimal characters (obtain independently)',
            )
          : undefined;
      const config: Connection = {
        id,
        name,
        protocol,
        host,
        port,
        username,
        remoteRoot,
        localRoot,
        privateKeyPath,
        hostKey,
        autoUpload: defaults.get('autoUpload', true),
        remotePollingMinutes: defaults.get('remotePollingMinutes', 10),
        lazyLoading: defaults.get('lazyLoading', true),
        excludes: defaults.get('excludes', []),
        timeout: defaults.get('timeout', 30000),
        retryAttempts: defaults.get('retryAttempts', 3),
        confirmRename: defaults.get('confirmRename', false),
        confirmMassDelete: defaults.get('confirmMassDelete', true),
      };
      this.validate(config);
      if (password)
        await this.context.secrets.store(`${id}.password`, password);
      if (passphrase)
        await this.context.secrets.store(`${id}.passphrase`, passphrase);
      await this.save(config);
      return config;
    } catch (e) {
      if (e instanceof Error && e.message === 'CANCELLED') return;
      throw e;
    }
  }
  validate(c: Connection): void {
    if (
      !c.name.trim() ||
      !c.host.trim() ||
      /[\r\n\0]/.test(c.host + c.username) ||
      !c.username ||
      !Number.isInteger(c.port) ||
      c.port < 1 ||
      c.port > 65535
    )
      throw new Error('Invalid name, host, username or port');
    remotePath(c.remoteRoot, '');
    if (c.webBaseUrl) browserBaseUrl(c.webBaseUrl);
    if (c.webRoot) relativePath(c.webRoot);
    if (
      !path.isAbsolute(c.localRoot) ||
      path.parse(c.localRoot).root === path.resolve(c.localRoot)
    )
      throw new Error(
        'Choose an absolute project directory, not a filesystem root',
      );
    const root = path.resolve(c.localRoot);
    const state = path.join(this.context.globalStorageUri.fsPath, 'state');
    if (
      state === root ||
      state.startsWith(root + path.sep) ||
      root.startsWith(state + path.sep)
    )
      throw new Error('Workspace must be separate from extension metadata');
    for (const existing of this.all())
      if (existing.id !== c.id) {
        const other = path.resolve(existing.localRoot);
        if (
          root === other ||
          root.startsWith(other + path.sep) ||
          other.startsWith(root + path.sep)
        )
          throw new Error(
            'Connections must use separate, non-overlapping local directories',
          );
      }
    if (
      !Array.isArray(c.excludes) ||
      c.excludes.some((p) => typeof p !== 'string')
    )
      throw new Error('Excludes must be a JSON array of glob strings');
    if (c.protocol === 'sftp' && !/^[a-f0-9]{64}$/i.test(c.hostKey ?? ''))
      throw new Error(
        'SFTP requires a trusted SHA-256 host key in hexadecimal format',
      );
    if (
      ![0, 5, 10, 15, 30].includes(c.remotePollingMinutes) ||
      !Number.isInteger(c.retryAttempts) ||
      c.retryAttempts < 0 ||
      c.retryAttempts > 5 ||
      c.timeout < 1000 ||
      c.timeout > 300000
    )
      throw new Error('Invalid polling, timeout or retry setting');
  }
  async edit(c: Connection): Promise<void> {
    const fields = [
      'name',
      'host',
      'port',
      'protocol',
      'username',
      'remoteRoot',
      'localRoot',
      'password',
      'privateKeyPath',
      'passphrase',
      'hostKey',
      'caFile',
      'webBaseUrl',
      'webRoot',
      'autoUpload',
      'remotePollingMinutes',
      'lazyLoading',
      'excludes',
      'timeout',
      'retryAttempts',
      'confirmRename',
      'confirmMassDelete',
    ] as const;
    const field = (await vscode.window.showQuickPick([...fields], {
      title: `Edit ${c.name} — select a field`,
    })) as (typeof fields)[number] | undefined;
    if (!field) return;
    try {
      if (field === 'password' || field === 'passphrase') {
        const value = await this.input(
          `${field}: blank removes stored secret`,
          '',
          true,
        );
        if (value) await this.context.secrets.store(`${c.id}.${field}`, value);
        else await this.context.secrets.delete(`${c.id}.${field}`);
        return;
      }
      const next = { ...c };
      let value: string | number | boolean | string[];
      if (typeof c[field] === 'boolean') {
        const pick = await vscode.window.showQuickPick(['true', 'false']);
        if (!pick) return;
        value = pick === 'true';
      } else if (field === 'protocol') {
        const pick = await vscode.window.showQuickPick(['ftp', 'ftps', 'sftp']);
        if (!pick) return;
        value = pick;
      } else {
        const text = await this.input(
          field,
          Array.isArray(c[field])
            ? JSON.stringify(c[field])
            : String(c[field] ?? ''),
        );
        value =
          field === 'excludes'
            ? (JSON.parse(text) as string[])
            : typeof c[field] === 'number'
              ? Number(text)
              : text;
      }
      Object.assign(next, { [field]: value });
      this.validate(next);
      if (
        [
          'host',
          'port',
          'protocol',
          'username',
          'remoteRoot',
          'localRoot',
        ].includes(field)
      ) {
        if (
          (await vscode.window.showWarningMessage(
            'Changing the association creates a new connection ID and history. The previous workspace and queue are retained. Choose a different local directory before opening a different server.',
            { modal: true },
            'Create New Association',
          )) !== 'Create New Association'
        )
          return;
        next.id = randomUUID();
        // A new local workspace avoids reusing old published content under a new identity.
        if (next.localRoot === c.localRoot)
          next.localRoot = path.join(
            this.context.globalStorageUri.fsPath,
            'workspaces',
            next.id,
          );
        for (const key of ['password', 'passphrase']) {
          const secret = await this.context.secrets.get(`${c.id}.${key}`);
          if (secret)
            await this.context.secrets.store(`${next.id}.${key}`, secret);
        }
      }
      await this.save(next);
    } catch (e) {
      if (e instanceof Error && e.message === 'CANCELLED') return;
      throw e;
    }
  }
}
