const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { runTests } = require('@vscode/test-electron');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsw-host-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  require('esbuild').buildSync({
    entryPoints: ['test/extension.host.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'dist/extension.host.cjs',
    external: ['vscode', 'ftp-srv'],
  });
  const installed =
    process.platform === 'win32'
      ? path.join(
          process.env.LOCALAPPDATA,
          'Programs',
          'Microsoft VS Code',
          'Code.exe',
        )
      : undefined;
  const candidate = process.env.VSCODE_EXECUTABLE || installed;
  let executable;
  if (candidate) {
    try {
      await fs.access(candidate);
      executable = candidate;
    } catch {}
  }
  const php = process.argv.includes('--php');
  const vsix = process.argv.includes('--vsix');
  let developmentPath = path.resolve('.');
  if (php || vsix) {
    if (!executable)
      throw new Error(
        'PHP compatibility test requires VSCODE_EXECUTABLE pointing to an installed VS Code.',
      );
    const base = path.dirname(executable);
    const candidates = [
      path.join(base, 'resources/app/out/cli.js'),
      ...(await fs.readdir(base)).map((dir) =>
        path.join(base, dir, 'resources/app/out/cli.js'),
      ),
    ];
    let cli;
    for (const file of candidates) {
      try {
        await fs.access(file);
        cli = file;
        break;
      } catch {}
    }
    if (!cli) throw new Error('Cannot locate VS Code CLI');
    await new Promise((resolve, reject) => {
      const child = spawn(
        executable,
        [
          cli,
          '--install-extension',
          vsix
            ? path.resolve(
                `remote-sync-workspace-${require('../package.json').version}.vsix`,
              )
            : 'bmewburn.vscode-intelephense-client',
          '--extensions-dir',
          path.join(root, 'extensions'),
          '--user-data-dir',
          path.join(root, 'profile'),
        ],
        {
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: 'inherit',
        },
      );
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error('Intelephense installation failed')),
      );
    });
    if (vsix) {
      const installed = (await fs.readdir(path.join(root, 'extensions'))).find(
        (name) => {
          const manifest = require('../package.json');
          return name.startsWith(`${manifest.publisher}.${manifest.name}-`);
        },
      );
      if (!installed) throw new Error('VSIX installation directory not found');
      developmentPath = path.join(root, 'extensions', installed);
    }
  }
  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: developmentPath,
      extensionTestsPath: path.resolve('dist/extension.host.cjs'),
      extensionTestsEnv: {
        RSW_TEST_ROOT: root,
        RSW_TEST_EXTENSION_ID: `${require('../package.json').publisher}.${require('../package.json').name}`,
        RSW_REPORT_DIR: path.resolve('test-results'),
        RSW_TEST_PHP: php ? '1' : '',
        RSW_TEST_VSIX: vsix ? '1' : '',
      },
      launchArgs: [
        workspace,
        ...(php ? [] : ['--disable-extensions']),
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--user-data-dir',
        path.join(root, 'profile'),
        '--extensions-dir',
        path.join(root, 'extensions'),
      ],
    });
  } finally {
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
