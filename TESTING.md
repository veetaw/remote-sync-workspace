# Testing and acceptance coverage

```sh
npm test                  # Unit, disk/Git, watcher, loopback FTP/FTPS/SFTP tests
npm run test:extension    # Real Extension Host with local FTP
npm run test:php          # Isolated Intelephense profile; network required
npm run lint
npm run build
npm run package
npm run test:vsix         # Test the generated package in an isolated profile
```

`npm run check` combines build, lint, and the ordinary automated suite.

Ordinary tests use temporary directories and servers bound to 127.0.0.1. They require neither containers nor a user server. Fake adapters write real disk content and inject deterministic faults; protocol integration tests use real FTP, TLS, and SSH/SFTP sockets. Development-only `ftp-srv` and `ssh2` test servers are not included in the VSIX. History tests use real Git, separate indexes, diffs, extraction, and binary restores.

## Coverage

| Area            | Checks                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connections     | FTP/FTPS/SFTP success, bad credentials, greeting timeout, reconnect, untrusted TLS, wrong host key                                                   |
| Workspace       | Persistent reopening, divergent existing workspace, missing directories, lazy and empty folders, truly empty files                                   |
| Local to remote | New files/binaries, edits during upload, duplicate events, delete/recreate coalescing, directory creation/deletion, file/directory renames           |
| Remote to local | New/modified/deleted files, unchanged metadata with changed content, dirty editor protection, interrupted listings/downloads                         |
| Crash/queue     | Reopening PENDING, RUNNING to UNCERTAIN, reconciled upload/rename results, no blind replay                                                           |
| Safety          | Traversal, local symlinks, case collisions, protected root, exclusions, blocked lazy deletion, corrupt snapshots, failed preflight/post-verification |
| Recovery        | Preserved conflicts, explicit local/remote resolution, Git snapshots/restores, merge markers, binary merge refusal                                   |
| Watcher         | Real chokidar, rapid external writes, excluded control files, no download-to-upload echo                                                             |
| Extension Host  | Activation, SecretStorage, commands, real PHP files, lazy context commands, verified save/upload, WorkspaceEdit rename/delete, diagnostics and views |
| Active file     | Read-only inspection, remote divergence, dirty buffer conflicts, no publication during inspection                                                    |
| PHP/HTML split  | Shared unsaved document, HTML detection outside PHP literals/comments, group reuse                                                                   |
| PHP tools       | Intelephense cross-file completion on materialized files                                                                                             |

The original acceptance scenarios are distributed across engine, real protocol, and Extension Host tests. The suite does not click through every QuickPick or manually install a VSIX by mouse. Packaging and file lists are verified separately; VSIX installation is tested using the CLI in an isolated profile.

Independent-client race windows, physical power loss, proprietary servers, and every OS combination cannot be certified by this suite. Passing tests does not imply atomic publication.

## Fault injection

`test/helpers.ts` implements a disk remote with failConnect, failList, failDownload, failUpload, corruptUpload, and duringUpload. Tests check bytes and persisted state rather than mock calls alone. Errors after partial remote writes must remain UNCERTAIN; later synchronization can verify the outcome or report a conflict.

Use disposable accounts and roots for additional tests. Do not introduce tests that delete data on external hosts. Test TLS certificates are explicitly trusted fixtures for those tests only; production TLS keeps certificate validation enabled.

See [docs/TEST-REPORT.md](docs/TEST-REPORT.md) for historical versions, results, and limitations.
