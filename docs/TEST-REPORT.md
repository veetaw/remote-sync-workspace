# Verification report

This report records earlier verification sessions. Historical results and dependency audit counts are snapshots, not current certification. Rerun the documented checks for each release.

## 0.1.2 update — November 24, 2026

- Active-file status in the editor title and status bar, with periodic remote content inspection separate from publication. Manual inspection is available through a command or the indicator.
- PHP/HTML split views of the same document: PHP at the beginning, HTML at a tag detected outside PHP strings, comments, and heredocs. Unsaved content is shared and existing split groups are reused.
- Build and lint passed; **90 tests passed** across 7 test files. The new engine test verifies that inspectFile leaves local content, remote content, baseline, and a PENDING operation unchanged even with divergence.
- **20 checks passed in VS Code 1.147.0 Extension Host**, including remote divergence, dirty-buffer conflicts, no publication during inspection, shared unsaved PHP/HTML navigation, and group reuse.
- The indicator describes the last verified read rather than a continuous guarantee. Periodic checks use bandwidth and may wait behind the serial queue.

## 0.1.1 update — separate views

- Package: `remote-sync-workspace-0.1.1.vsix`, with a dedicated Activity Bar container, all connections, and expandable details.
- Explorer reduced to two rows for the active connection, gated by `remoteSync.active` and cleared at session close.
- Build, lint, and 69 automated tests passed after the change.
- VSIX installed and verified in isolated VS Code 1.147.0: **17 integration checks passed**, including icon/container, two connections in the detailed view, active-connection isolation, and inactive state.
- A pending VS Code update blocked the installed application. Testing used a separate ZIP distribution without changing the update or normal user profile.

## Initial 0.1.0 artifacts and environment — November 18, 2026

- Strict TypeScript source, manifest, lockfile, build, F5 debugging, tests, documentation, and licenses included.
- Local package: `remote-sync-workspace-0.1.0.vsix`, development publisher `remote-sync-local`. Locally installable; not published or signed.
- Verified system: Windows x64; Node CLI 22.20.0, npm 10.9.3, Git 2.51.0.windows.1.
- VS Code 1.146.0; Extension Host Node 24.22.1.
- Clients: basic-ftp 6.2.6, ssh2-sftp-client 12.1.1, chokidar 4.0.3. Isolated Intelephense 1.18.5.
- Declared minimum: VS Code 1.110+, development Node 22.12+. The minimum VS Code version was not executed in that session.

## Initial verified results

| Check                                                                                     | Result                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------ |
| Strict TypeScript and bundle                                                              | PASS                                       |
| ESLint                                                                                    | PASS                                       |
| Vitest                                                                                    | **69 passed, 0 failed**, 6 test files      |
| Real disk, persistent queue, blobs, and Git                                               | PASS                                       |
| Loopback FTP connection, bad authentication, binaries, listing, mkdir/rename/delete       | PASS                                       |
| FTPS rejects untrusted certificates; transfer succeeds with explicit test CA              | PASS                                       |
| SFTP verifies host keys, rejects mismatch/bad authentication, transfers and mutates files | PASS                                       |
| Bundled SFTP without optional native accelerators                                         | PASS, 256 KiB binary round trip            |
| Real chokidar, rapid writes, excluded private files                                       | PASS                                       |
| Source Extension Host                                                                     | PASS                                       |
| VSIX installed and tested in a temporary profile                                          | PASS, 13 integration checks                |
| Intelephense on downloaded files                                                          | PASS, cross-file symbol completion         |
| vsce packaging and content inspection                                                     | PASS                                       |
| Runtime dependency audit                                                                  | **0 reported vulnerabilities at the time** |

The suite covered truly empty remote files, lazy/empty folders, divergent existing projects, dirty editors, edits during upload/download, conflicts, deletion, lazy renames, PENDING/RUNNING restarts, UNCERTAIN outcomes, failed post-verification/listings, corrupt snapshots, traversal, symlinks, case collisions, delete/recreate coalescing, binary restore, and history through renames.

The VSIX runner installed into a temporary extensions directory, then used the installed extension as its development path rather than the source bundle. Real commands exercised opening, lazy loading, verified save/upload, native rename/delete, synchronization, conflicts, and diagnostics. Configuration seeding is available only in ExtensionMode.Test; production has no command to import plain-text secrets.

The PHP test installed Intelephense only in an isolated profile, materialized the remote module, and called `vscode.executeCompletionItemProvider` in another local PHP file. An initial short wait failed to produce completion. The repeated check waited for language-server readiness and opened the module document explicitly, then passed. Instant indexing of lazy files is not assumed.

Raw reports under `test-results/` include vitest.json, extension-host.json or vsix-host.json, php-compatibility.json, runtime-audit.json, and development-audit.json. They are ignored by Git and excluded from the VSIX. Host logs also included messages from built-in VS Code components; the runner exited successfully.

## Historical development-tool audit

The complete audit at the time reported **16 transitive/development vulnerabilities: 14 high, 2 moderate**. Runtime-only `npm audit --omit=dev` reported zero. Chains primarily involved picomatch/tinyglobby in Vitest/ESLint/vsce, minimatch inside vsce, and ip/uuid in ftp-srv. Development tools and test servers are excluded from the VSIX; the lockfile preserves tested versions.

An attempted `npm audit fix` failed with an internal npm resolver error. No forced downgrades or unverified overrides were applied to hide findings. Test servers bind to loopback and use disposable directories. Tools need compatible updates and revalidation as fixes become available. Audit results do not prove absence of vulnerabilities.

## Limits and checks not performed in the historical sessions

1. Public APIs cannot intercept native Explorer expansion; lazy loading uses context commands. VS Code and the user control the compact view's placement.
2. Direct FTP/FTPS/SFTP uploads are not atomic and may leave partial content. No supported protocol provides portable compare-and-swap. See SECURITY.md for remote and local writer race windows.
3. Strong verification rereads content in materialized directories even with unchanged metadata. Lazy trees are not all downloaded, but bandwidth costs can be significant.
4. Recursive deletion of lazy directories is blocked. Materialize the tree first; verified files are removed before empty directories. New remote content or conflicts block deletion. Disappearing remote directories conservatively retain local structure and are reported.
5. Unidentifiable external renames and cross-workspace moves need conservative reconciliation. Symlinks/exclusions block remote directory renames. The first blocking error stops dependent work.
6. History requires Git and disk space, with no automatic garbage collection. Project content and history are ordinary local data requiring protection and backups. Text merges are limited to 16 MiB per version; binary transfer/restore uses streams. Large files or slow connections may need a longer timeout.
7. Explicit FTPS and SFTP password/key authentication are supported. Implicit FTPS, proxy/jump hosts, SSH agent, interactive authentication, and certification for all proprietary servers were not implemented.
8. Linux/macOS execution, physical power loss, OS crashes, every FTP server variant, hostile server mounts/symlinks, and million-file projects were not verified in those sessions. A three-OS CI matrix is provided without claiming it ran.
9. Native creation/editing UI and SecretStorage were exercised in the host, but every wizard screen was not clicked automatically. Isolated VSIX CLI installation was verified; manual mouse installation was not.

No user servers or credentials were used, and nothing was installed into the user's normal VS Code profile.
