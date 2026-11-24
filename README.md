# Remote Sync Workspace

Edit remote projects as persistent local workspaces in Visual Studio Code. Connect over FTP, explicit FTPS, or SFTP, work in the native Explorer, and synchronize changes with content verification, conflict handling, and private Git history.

## Features

- **Real local files:** use your existing language servers, search, linters, and development tools.
- **FTP, FTPS, and SFTP:** manage multiple connections from a dedicated Activity Bar view.
- **Download on demand:** load one directory, download a subtree, or materialize the whole project for indexing.
- **Verified synchronization:** compare remote content against a SHA-256 baseline before uploading, then read it back to verify the result.
- **Persistent operations:** preserve queued changes and reconcile interrupted transfers after reopening VS Code.
- **Conflict resolution:** compare versions, review a three-way merge candidate, or explicitly keep the local or remote version.
- **Recoverable history:** preserve observed file versions in a private Git repository outside your project.
- **Native feedback:** Explorer badges, a compact status view, logs, and operation diagnostics.

## Requirements

- VS Code **1.110 or later**, running on the desktop.
- **Git CLI** available on `PATH`.
- A trusted workspace and an FTP, explicit FTPS, or SFTP server.

The code supports Windows, macOS, and Linux. Historical verification was performed on Windows; the repository includes a CI matrix for all three operating systems. This extension does not provide a language server. PHP and other language tools can index only files that have been downloaded.

## Install

Until the extension is published, build or obtain a VSIX package. In VS Code, open **Extensions → … → Install from VSIX…** and select it. To build from source, see [Development](DEVELOPMENT.md).

## Connect to a project

1. Open the **Remote Sync** icon in the Activity Bar, or run **Remote Sync: Add Connection** from the Command Palette.
2. Enter the connection name, protocol, host, port, username, absolute remote root, and local workspace directory.
3. Enter your password or configure an SFTP private key. Passwords and key passphrases use VS Code SecretStorage.
4. For SFTP, enter the server's SHA-256 host fingerprint as **64 hexadecimal characters**, obtained from an independently trusted source. Unknown host keys are not accepted automatically.
5. Select **Test Connection**, then **Connect / Open Workspace**.

Plain FTP transmits credentials and content without encryption. Prefer SFTP or FTPS. Explicit FTPS validates TLS certificates; use the connection's `caFile` setting for a private CA. Implicit FTPS, jump hosts, SSH agent, and interactive authentication are not supported.

Each connection has a persistent local workspace. The Activity Bar view lists all saved connections, with expandable settings and actions. The compact **Remote Sync** view in Explorer appears only when a connection is active; its toolbar provides **Sync Now**, **Pause / Resume Upload**, and **Connection Settings**.

## Download files

With lazy loading enabled, the first connection downloads root-level files and creates real, initially empty subdirectories. A `↓` badge on a discovered directory means its contents have not been downloaded; it does not mean the remote directory is empty. No placeholder files are created.

Right-click a directory in Explorer and choose:

- **Download Directory / Refresh Directory** to load one level.
- **Download Recursively** to load the selected subtree.
- **Download Entire Project for Indexing** to load the whole project, respecting exclusions and local changes.

Expanding a folder in the native Explorer cannot trigger a download through VS Code's public API. Use these commands to materialize directories. Interrupted scans are not marked complete. Lazy states are `UNKNOWN`, `DISCOVERED`, `LOADING`, `MATERIALIZED`, and `ERROR`.

## Synchronization

### Current-file indicator and PHP / HTML split

The active remote-workspace file has an indicator in the editor title and a colored dot with a label in the status bar. It distinguishes matching content at the last check, local changes (including unsaved edits), remote changes, diverging local/remote content, checking, and a failed check. The tooltip includes the last content-check time. An unreachable server is not shown as synchronized.

The current file is checked every **15 seconds**, independently of workspace synchronization. Set `remoteSync.activeFileCheckSeconds` (5–300 seconds) to change the interval. Click the indicator or run **Check Current File Against Server (Read Only)** to check immediately. This reads remote content into private snapshots for comparison; it does not publish queued operations, delete files, or replace the workspace document. Normal synchronization continues separately. These are periodic checks rather than push notifications; another operation in the serialized connection can delay a check.

The **Split PHP / HTML in the Same File** button in the editor title opens two views of the **same document**: the PHP beginning on the left and the first `<html>` element outside PHP code and HTML comments on the right. Unsaved edits are shared. The command does not save, create a copy, or upload anything. An existing second view is reused. If no HTML element is found, it opens a normal split at the current position and explains the fallback. The button is available for PHP, PHTML, HTML and HTM files, including local files outside a remote workspace. VS Code controls its exact position relative to the built-in split button.

Saved files and stable external edits enter the persistent queue independently of remote polling. The watcher waits for 400 ms of stability and applies a 450 ms debounce; active transfers and queued operations can add delay. Uploads use immutable local snapshots.

Before uploading, the extension reads remote content and compares it against the last shared SHA-256 baseline. It writes directly to the final remote path, reads the file back in full, and records success only after verification and state persistence.

**Direct uploads are not atomic. An interrupted upload can leave a partial remote file.** Ambiguous operations become `UNCERTAIN`, retain the complete queued local version, and are not blindly retried. FTP/SFTP do not provide a portable atomic compare-and-write operation: another client can change a file between the preflight check and the write, or after verification. See [Security and integrity limits](SECURITY.md).

**Sync Now** checks root-level files and materialized directories, refreshes known lazy inventories, and processes the queue even when automatic upload is disabled. An explicit pause remains in effect. Remote polling defaults to 10 minutes and can be disabled or set to 5, 10, 15, or 30 minutes. Reconciliation reads content even when size and timestamps match, which increases bandwidth use.

Remote updates do not replace dirty editor documents, divergent local content, or pending local operations. Downloads are completed in private storage before local replacement. A failed listing is never treated as an empty directory. Sessions are reused and serialized, with bounded reconnect attempts. Local files and queued work remain available while the server is offline.

New files, directories, renames, moves, and deletions are propagated conservatively. Renames require an unchanged source and an absent destination. Remote directory deletion requires a fully materialized tree, verified files, and empty directories after their children are removed. Lazy directories are never treated as implicit deletions. Native delete/rename hooks try to preserve saved changes before the local operation; external watchers cannot recover bytes they never observed. Cross-workspace moves require conservative reconciliation; unidentifiable external renames are handled as verified create/delete operations.

## Status and recovery

| Badge | Meaning                                                |
| ----- | ------------------------------------------------------ |
| None  | Online and synchronized at the last verified operation |
| `↑`   | Pending or uploading; inspect the tooltip              |
| `↓`   | Downloading, or a directory waiting to be materialized |
| `!`   | Error or uncertain transfer                            |
| `C`   | Conflict requiring resolution                          |
| `○`   | Offline; only the last known baseline is available     |

Select the status bar item or run **Operations and Diagnostics** to inspect a JSON snapshot of operations, attempts, controlled errors, baselines, and known remote versions. Reopen the command to refresh the snapshot. **Show Log** opens the dedicated Output Channel.

**Resolve Conflict** offers Compare, Open Three Way Merge, Keep Remote, and Keep Local & Upload. Keeping the remote version preserves the local version first. Keeping the local version authorizes a newly verified baseline before the normal upload checks.

Three-way merges use `git merge-file --diff3` for text files up to 16 MiB per version. Review and save the separate candidate, resolve all markers, then choose **Apply Saved Candidate**. Publishing the resolved conflict requires **Keep Local & Upload**. Binary files require an explicit choice; merges are not applied automatically.

**Retry Failed Operations** retries safe failures from before a mutation, within the configured limit and after rechecking the baseline. **Recover / Abandon Blocked Operation** reconciles ambiguous structural operations and permits a retry only when its preconditions are verified. Abandoning an operation does not undo its effects or mark it successful. A blocked operation stops dependent work to preserve order.

When recovery is needed, pause uploads, inspect diagnostics and the server, reconnect, run **Sync Now**, and resolve uncertain files explicitly. Do not delete extension metadata to unblock the queue.

## Active file status and PHP/HTML views

The active file indicator shows its last checked synchronization status. Remote inspections are separate from publication; periodic checks use bandwidth and may wait behind the connection queue. The indicator describes the last observation, not a continuous guarantee.

Use **Remote Sync: Split PHP / HTML in the Same File** to view one document in two editor groups, including unsaved changes. One view starts at PHP and the other navigates to detected HTML outside PHP strings, comments, and heredocs. Existing split groups are reused.

## History and settings

Use **View History / Restore Version** to inspect, compare, or restore a file revision. For a deleted file, run the command without an active file and enter its relative path. A deletion commit contains no file bytes; select an earlier revision. Restoring creates a new local change that follows the normal synchronization queue.

Git history uses its own repository and index; it does not create a `.git` directory inside the synchronized workspace or use your project's Git index. Snapshots distinguish `INITIAL_REMOTE`, `LOCAL_CHANGE`, `REMOTE_CHANGE`, `CONFLICT_RESOLUTION`, and `MANUAL_RESTORE`. Binary revisions are preserved and restored using streams. Opening a connection fails safely if Git is unavailable.

Most `remoteSync.*` settings provide **defaults for new connections**. Each connection stores its own copy, editable through **Edit Connection**. `showDecorations` and `logLevel` are read directly from global settings. Transfers are serialized per connection; history cannot be disabled.

Changing the host, port, protocol, username, remote root, or local directory creates a new association and UUID. Previous workspaces, state, and queued content remain available. Deleting a connection removes its configuration and secrets, while preserving local files and history. Overlapping local workspace directories are rejected.

State, content blobs, and Git history live under `ExtensionContext.globalStorageUri/state/<UUID>/`; default workspaces live under `globalStorageUri/workspaces/<UUID>/`. `.git`, `.remote-sync*`, `[DIR] *`, common temporary files, and configured exclusions are not uploaded. History is not automatically pruned. Plan for disk usage and independent backups; project secrets can remain in local history as ordinary file content.

## Contribute and publish

- [Development](DEVELOPMENT.md)
- [Testing](TESTING.md) and [historical test report](docs/TEST-REPORT.md)
- [Architecture](ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md) and [support](SUPPORT.md)
- [GitHub setup, packaging, and Marketplace publishing](PUBLISHING.md)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
