# Changelog

## Unreleased

- Prepare English project documentation, GitHub metadata, contribution guidelines, and Marketplace publishing instructions.
- Generate third-party notices during the VS Code prepublish step.
- Preserve the configured version and publisher when regenerating manifest contributions.
- Discover the packaged extension using its configured publisher in VSIX integration tests.
- Add a manually triggered Marketplace publishing workflow using OIDC Trusted Publishing.

## 0.1.2 — 2026-11-24

- Show active-file synchronization status with read-only remote inspection.
- Add PHP/HTML split views of the same document, including unsaved content and existing-group reuse.
- Extend engine and Extension Host checks for inspection and editor navigation.

## 0.1.1 — 2026-11-18

- Add the Remote Sync Activity Bar icon and a dedicated view for all connections, expandable details, and native actions.
- Reduce the Explorer view to two rows for the current connection and hide it when no connection is active.
- Separate connection management actions from the compact view's operation buttons.
- Add Extension Host checks for the container, icon, connection details, and compact view isolation.

## 0.1.0 — 2026-11-18

- Persistent local workspaces for FTP, explicit FTPS, and SFTP.
- Native connection management with SecretStorage, validated TLS, and mandatory SSH host fingerprints.
- Lazy loading through native Explorer context commands and recursive downloads for indexing.
- Direct uploads with content preflight checks, immutable snapshots, full verification, and UNCERTAIN state.
- Persistent queue, restart reconciliation, stable watcher, and ordered mutations.
- Protection for lazy directories, renames, deletions, traversal, symlinks, and exclusions.
- Private Git history, binary restore, and reviewable three-way merges.
- Compact view, badges, status bar, cancellable progress, logs, and diagnostics.
- Disk tests, real loopback protocol tests, Extension Host tests, and isolated Intelephense verification.
