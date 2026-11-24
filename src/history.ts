import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { relativePath } from './safety';

const exec = promisify(execFile);
export type Origin =
  | 'INITIAL_REMOTE'
  | 'LOCAL_CHANGE'
  | 'REMOTE_CHANGE'
  | 'CONFLICT_RESOLUTION'
  | 'MANUAL_RESTORE';
export class History {
  constructor(
    readonly directory: string,
    readonly workTree: string,
  ) {}
  private environment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // Caller Git environment must never redirect the private index or objects.
    for (const name of Object.keys(env))
      if (name.startsWith('GIT_')) delete env[name];
    return {
      ...env,
      GIT_DIR: this.directory,
      GIT_WORK_TREE: this.workTree,
      GIT_INDEX_FILE: path.join(this.directory, 'index'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(this.directory, 'no-global-config'),
      GIT_AUTHOR_NAME: 'Remote Sync Workspace',
      GIT_AUTHOR_EMAIL: 'local@remote-sync.invalid',
      GIT_COMMITTER_NAME: 'Remote Sync Workspace',
      GIT_COMMITTER_EMAIL: 'local@remote-sync.invalid',
    };
  }
  private async git(args: string[]): Promise<string> {
    return (
      await exec(
        'git',
        [
          `--git-dir=${this.directory}`,
          `--work-tree=${this.workTree}`,
          '-c',
          'core.autocrlf=false',
          '-c',
          `core.hooksPath=${path.join(this.directory, 'disabled-hooks')}`,
          '-c',
          'core.fsmonitor=false',
          ...args,
        ],
        {
          env: this.environment(),
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
        },
      )
    ).stdout;
  }
  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.directory), { recursive: true });
    await this.git(['init']);
  }
  async snapshot(
    file: string,
    origin: Origin,
    operationId?: string,
    contentFile?: string,
  ): Promise<void> {
    relativePath(file);
    // Construct the index from individual content; never traverse an embedded user repository.
    const target = contentFile ?? path.join(this.workTree, ...file.split('/'));
    let hash: string;
    try {
      await fs.access(target);
      hash = (
        await this.git(['hash-object', '-w', '--no-filters', '--', target])
      ).trim();
      await this.git([
        'update-index',
        '--add',
        '--cacheinfo',
        '100644',
        hash,
        file,
      ]);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await this.git(['update-index', '--force-remove', '--', file]);
    }
    await this.git([
      'commit',
      '--allow-empty',
      '-m',
      JSON.stringify({
        timestamp: new Date().toISOString(),
        origin,
        path: file,
        description: `${origin}: ${file}`,
        operationId,
      }),
    ]);
  }
  async log(file?: string): Promise<string> {
    return this.git([
      'log',
      '--format=%H %s',
      ...(file ? ['--follow'] : []),
      ...(file ? ['--', relativePath(file)] : []),
    ]);
  }
  async move(from: string, to: string): Promise<void> {
    relativePath(from);
    relativePath(to);
    const files = (await this.git(['ls-files', '-z', '--', from]))
      .split('\0')
      .filter(Boolean);
    for (const old of files) {
      const next = to + old.slice(from.length);
      const target = path.join(this.workTree, ...next.split('/'));
      try {
        await fs.access(target);
        const hash = (
          await this.git(['hash-object', '-w', '--no-filters', '--', target])
        ).trim();
        await this.git([
          'update-index',
          '--add',
          '--cacheinfo',
          '100644',
          hash,
          next,
        ]);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await this.git(['update-index', '--force-remove', '--', old]);
    }
    if (files.length)
      await this.git([
        'commit',
        '--allow-empty',
        '-m',
        JSON.stringify({
          timestamp: new Date().toISOString(),
          origin: 'LOCAL_CHANGE',
          path: to,
          description: `Move ${from} to ${to}`,
        }),
      ]);
  }
  async version(commit: string, file: string, output: string): Promise<void> {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid revision');
    let revisionPath = relativePath(file);
    const changes = (
      await this.git([
        'log',
        '--follow',
        '--format=',
        '--name-status',
        '-z',
        `${commit}..HEAD`,
        '--',
        revisionPath,
      ])
    ).split('\0');
    for (let i = 0; i < changes.length;) {
      const status = changes[i++].trim();
      if (!status) continue;
      if (/^[RC]\d+$/.test(status)) {
        const previous = changes[i++],
          next = changes[i++];
        if (next === revisionPath) revisionPath = previous;
      } else i++;
    }
    const child = spawn(
      'git',
      [
        `--git-dir=${this.directory}`,
        'show',
        `${commit}:${relativePath(revisionPath)}`,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.environment(),
      },
    );
    child.stderr.resume();
    const completed = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                'Cannot retrieve Git version (the selected commit may represent deletion)',
              ),
            ),
      );
    });
    await Promise.all([
      pipeline(child.stdout, createWriteStream(output, { mode: 0o600 })),
      completed,
    ]);
  }
}
