# Development

Requirements: Node.js 22.12+, npm, Git CLI, and VS Code 1.110+. PHP is not required to build or run engine tests. Test certificates and keys are public fixtures and must never be reused on a real server.

```sh
npm ci
npm run check
npm run test:extension
npm run package
```

`npm ci` installs the lockfile's versions. `npm run build` runs strict TypeScript checks and bundles the extension as CommonJS in `dist/extension.js`. Runtime libraries are bundled; `vscode` is supplied by the Extension Host. The optional native `cpu-features` accelerator is not shipped; the portable JavaScript path remains available.

Open the project in VS Code and press **F5**. The build task runs before the Extension Development Host starts. Connect to a disposable test server.

`npm run package` uses the prepublish hook to build and generate notices, then creates `remote-sync-workspace-<version>.vsix`. The package excludes tests, local servers, fixture keys, research files, and node_modules. It includes the runtime bundle, source map, manifest, resources, license, notices, and documentation. Do not place real credentials in example configuration or bypass vsce's secret checks.

## Manifest

`package.json` is the manifest. `scripts/configure.cjs` regenerates contributions and scripts; run it only when intentionally changing those contributions. It preserves the current version and publisher. Settings are machine-scoped: a synchronized repository cannot choose the publishing host or inject connection secrets through versioned settings.

The repository URL is configured for `veetaw/remote-sync-workspace`. The local publisher `remote-sync-local` must be replaced by a registered publisher before publishing. See [PUBLISHING.md](PUBLISHING.md).

## VS Code and PHP tests

`npm run test:extension` uses `@vscode/test-electron`, an installed Windows VS Code when available, or an isolated download. Set `VSCODE_EXECUTABLE` to select another executable. Temporary user profiles and extension directories are removed afterward; the normal user profile is not modified.

After packaging, `npm run test:vsix` installs and tests the generated VSIX in an isolated profile. Installed extension discovery uses the publisher and name in the manifest.

`npm run test:php` requires an installed VS Code, network access, and installs Intelephense only in the temporary profile. It checks cross-file completion using materialized PHP files. On Linux without a display, use `xvfb-run -a npm run test:extension`.

The tests use public APIs and a configuration-seeding API available only in `ExtensionMode.Test`, followed by real commands, WorkspaceEdit, and normal save events. JSON reports are written under `test-results/`. See [TESTING.md](TESTING.md) and the [historical report](docs/TEST-REPORT.md). Loopback credentials have no validity outside the test fixtures.

## Synchronization and recovery invariants

Do not add upload retries for generic exceptions. Set `mutated` immediately before an operation that can change the server; from then on, an error is ambiguous. Later dependent operations must not bypass a blocked queue. Never turn a failed listing into an empty array, a missing hash into a valid baseline, or CANCELLED into VERIFIED.

Changing destination identity requires a new association. Persistent schema changes need an explicit migration or conservative refusal, without clearing files or operations. Do not add control files to the published tree. Do not use the user's Git repository for extension snapshots.
