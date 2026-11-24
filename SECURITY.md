# Security and integrity limits

## Reporting a vulnerability

Use **Report a vulnerability** on the repository's [Security tab](https://github.com/veetaw/remote-sync-workspace/security) once private vulnerability reporting is enabled. Do not post credentials, private keys, or exploit details in a public issue. If private reporting is unavailable, contact the maintainer through an available private channel before sharing sensitive details.

## Transport and credentials

Preserving observed content and reporting uncertainty are priorities. The extension does not provide distributed transactions or atomic publication. Keep independent backups of server and local data: local history cannot protect against disk loss.

- Passwords and key passphrases use VS Code SecretStorage, rather than connection JSON, workspaces, or logs. Its physical protection depends on the operating system and VS Code installation.
- Logs and persisted operations contain controlled errors only. Arbitrary library exceptions can contain credentials and are not printed. File contents are not logged.
- FTP is unencrypted. Explicit FTPS validates TLS certificates, hostname/IP, and CA. A private CA can be selected with `caFile`.
- SFTP requires an independently obtained SHA-256 hexadecimal host fingerprint. There is no silent trust on first use. The SFTP root must be canonical, rather than a symlink or alias.
- Workspace Trust is required. Configuration and state are machine-scoped; a repository cannot choose the publishing host.

## Paths and exclusions

Relative paths cannot contain traversal, empty segments, Windows separators, control characters, alternate data streams, device names, trailing dots/spaces, or nonportable names. Remote roots are absolute POSIX paths and cannot themselves be renamed or deleted. Listings reject case and normalized Unicode collisions; remote symlinks are not materialized. Remote ancestors are checked through listings; local symlinks, including workspace ancestors, are rejected.

The extension does not upload `.git`, `.remote-sync*`, `[DIR] *`, common temporary files, or excluded glob patterns. Git and metadata stay outside the workspace. The UI rejects overlapping local connection directories. A workspace lock protects a connection UUID between extension processes; it cannot control other programs writing directly to files.

## Integrity guarantees and remaining windows

1. Upload preflight reads the complete remote content and compares its SHA-256 against the baseline. After the direct write, the extension reads the full remote file again and verifies SHA-256. Size and timestamp alone are insufficient.
2. **A direct upload can truncate or partially replace the remote file.** Publication does not use remote temporary files and rename. An interruption, mismatch, or unavailable verification after mutation means UNCERTAIN and blocks dependent work. The queued local version remains recoverable.
3. FTP/SFTP do not provide portable compare-and-swap. Other clients can write after preflight or verification. A remote read can overlap another writer. Verification describes content observed during that check, rather than future immutability or a transactional server snapshot. Avoid concurrent writers when exclusive access is required.
4. External local programs introduce a similar window: dirty/hash checks and local replacement are close together but do not form a portable filesystem compare-and-swap. Observed versions are preserved, but an external write between the check and rename cannot be excluded. The extension serializes its own operations only.
5. An FTP server can hide symlinks or use mounts/aliases. The adapter can reject only symlinks reported in listings. Effective confinement also requires server permissions or chroot. A hostile server or misleading listing is not a trusted authority.
6. An external process can replace an ancestor with a symlink between validation and use. Checks reduce this risk; Node does not provide a complete portable openat/no-follow traversal for all operations used. A hostile local user with workspace or metadata access is outside this exclusivity model.
7. fsync and rename protect against many process crashes, but not every disk/controller, network filesystem, physical power loss, or system failure. Node on Windows does not provide equivalent directory fsync. Corrupt state or ambiguous locks block opening without automatic reset.
8. Saved and observed files are recoverable. Bytes never observed, such as a file created and deleted before the watcher sees it, cannot be reconstructed. Remote deletion requires a recoverable baseline. VS Code will-delete/will-rename events improve preservation but remain subject to host time limits.

## Deletion, renaming, and recovery

Recursive deletion is never delegated to the server. An incomplete or lazy local tree does not authorize remote deletion. Files require a recoverable baseline and unchanged remote content; directories must be empty after their children are removed. Native confirmation applies to remote propagation: public APIs do not guarantee cancellation of an earlier local operation. Rejected propagation leaves history and reconciliation available.

A rename does not overwrite an existing destination and verifies the source and result. Directory renames preserve a complete manifest and remote content blobs. Symlinks, exclusions, or divergence block the operation. Reading and verifying a whole tree can be expensive.

Git uses an explicit index and work-tree separate from the user's repository. The extension uses ordinary private history and shared content-addressed blobs instead of remote backups or an independent copy for every rename/delete. Local data, including secrets inside project files, remain in history as ordinary unencrypted file content. Protect storage and backups. Automatic garbage collection is not provided.

For UNCERTAIN operations, inspect the server, use Sync Now, and choose an explicit resolution. Do not remove state or blindly repeat destructive actions. Abandoning an operation does not undo effects or declare success. Preserve the UUID, workspace, and state before removing a connection when recovery is needed.

Run `npm audit --omit=dev` to check current runtime dependency advisories. Test servers and fixture keys are excluded from the VSIX.
