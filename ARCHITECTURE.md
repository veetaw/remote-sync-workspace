# Architecture

## Components and invariants

| Component                       | Implementation                  | Responsibility                                                                              |
| ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| Extension controller            | src/extension.ts                | Lifecycle, trust, commands, VS Code events, cancellable progress                            |
| Connection UI                   | src/connections.ts              | UUIDs, native QuickPick/InputBox, validation, SecretStorage                                 |
| Connection manager and adapters | src/adapters.ts                 | Reused sessions, bounded backoff, TLS/SSH, timeouts, streaming FTP/FTPS/SFTP                |
| Workspace and synchronization   | src/engine.ts                   | Materialization, lazy inventories, three-version reconciliation, verified ordered mutations |
| Local watcher                   | src/watcher.ts                  | chokidar stability/debounce, native event holds, follow-up scans                            |
| Persistent queue                | src/storage.ts, src/engine.ts   | Atomic state persistence, immutable snapshots, RUNNING recovery                             |
| Conflict manager                | src/conflicts.ts, src/engine.ts | Baselines, comparison, resolution, separate merge candidates                                |
| Git history                     | src/history.ts                  | Private index, per-file commits, streamed binary recovery                                   |
| Connection view                 | src/connection-view.ts          | Saved connections, expandable details, native actions                                       |
| Explorer/status                 | src/ui.ts                       | Compact view, file decorations, connection status                                           |
| Active file status              | src/active-file.ts              | Read-only remote checks and active file indicators                                          |
| PHP/HTML split                  | src/split-editor.ts             | Two views of the same document with PHP/HTML navigation                                     |
| Path safety                     | src/safety.ts                   | Confined POSIX paths, portable names, symlinks, collisions, exclusions                      |

The workspace contains ordinary local files rather than a virtual filesystem. Components share a serial queue per connection. Causal ordering and FTP limitations take priority over parallel transfer speed.

`RemoteAdapter` declares capabilities, cancellation, and progress. Transfers use library files/streams without loading whole binaries into memory. Existence is established from a complete parent listing; errors never mean absence. The adapter does not claim server hashes or atomicity the protocols cannot guarantee.

## Versions and persistence

A baseline is the SHA-256 of the last verified shared content, or null for known absence. Blobs are content-addressed and verified before use in publication or comparison. Uploads use acquired, disk-synchronized blobs. If local content changes during a transfer, its new version is captured and queued after verification.

State includes the full connection association, file baselines/status, lazy inventories, last synchronization, and operations with UUIDs, paths, timestamps, attempts, local version, baseline, result, and controlled errors. Directory renames also retain a complete remote content manifest. Pending work may coalesce by path only without crossing causal operations. VERIFIED requires remote evidence; CANCELLED records supersession or abandonment without implying success.

State writes use a private temporary file, fsync, and rename. Blobs are synchronized before the queue references them. POSIX directories are synchronized too; equivalent directory fsync is unavailable through Node on Windows. An exclusive lock prevents multiple owners of one UUID. Only a provably nonexistent PID permits breaking a lock; PID reuse, incomplete locks, or insufficient permissions block opening.

On restart, RUNNING becomes UNCERTAIN. Ambiguous operations are checked against the remote server and are not repeated when their outcome cannot be proved. Network recovery alone does not authorize replay. Dependent operations stop at the first blocking error. Polling, downloads, and watcher work are serialized per UUID; independent clients do not participate in this lock.

## Reconciliation

1. Obtain and validate a successful remote listing.
2. Read remote content, even when size and modification time appear unchanged.
3. Compare local, baseline, and remote versions, including dirty editor checks.
4. For remote-only changes, preserve recoverable content and install a complete local download.
5. For local-only changes, capture a snapshot and queue it; preflight the remote before mutation.
6. For divergence or uncertainty, preserve versions and request explicit resolution.
7. Upload directly, read back in full, compare the queued hash, and persist VERIFIED.

Initial opening does not overwrite a divergent existing workspace. Reopening first considers interrupted operations and baselines; local scanning also detects edits made while the extension was closed. Clean remote file deletions preserve history before local removal. Disappearing remote directories are reported while local structure is conservatively retained.

Lazy directories are never implicit deletions. Grouped native deletion requires a fully materialized tree and verifies every file, removing directories nonrecursively after children. Renames use protocol commands without remote temporary writes; trees are preserved and compared in full first.

## Explorer and editor integration

`onDidExpandElement` belongs to an extension-owned TreeView; no public API exposes the native Explorer TreeView. Active editor events observe documents, not folder expansion. Lazy loading therefore uses context commands. The compact view cannot be programmatically pinned above the native file tree.

The Activity Bar container uses `resources/remote-sync.svg` and lists all connections. The separate Explorer view has two rows for the current connection and is gated by `remoteSync.active`. Manage Connections opens the dedicated container.

Three-way merging uses Git CLI and a reviewable candidate rather than private Merge Editor commands. Read-only comparison content uses private blobs whose hashes are checked before use.

Active-file inspection reads remote content separately from publication. Its indicator describes the last checked state and can wait behind the serial queue. PHP/HTML split views share one document, including unsaved changes; HTML navigation skips PHP strings, comments, and heredocs, and existing split groups are reused.
