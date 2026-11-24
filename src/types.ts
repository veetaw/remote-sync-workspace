export type Protocol = 'ftp' | 'ftps' | 'sftp';
export interface Connection {
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  remoteRoot: string;
  localRoot: string;
  privateKeyPath?: string;
  hostKey?: string;
  autoUpload: boolean;
  remotePollingMinutes: number;
  caFile?: string;
  webBaseUrl?: string;
  webRoot?: string;
  lazyLoading: boolean;
  excludes: string[];
  timeout: number;
  retryAttempts: number;
  confirmRename: boolean;
  confirmMassDelete: boolean;
}
export interface Credentials {
  password?: string;
  passphrase?: string;
}
export interface RemoteEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modified?: number;
}
export interface TransferContext {
  signal?: AbortSignal;
  progress?: (bytes: number) => void;
}
export interface RemoteAdapter {
  readonly capabilities: { streams: boolean; atomicUpload: false; hash: false };
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  list(path: string, context?: TransferContext): Promise<RemoteEntry[]>;
  download(
    remote: string,
    local: string,
    context?: TransferContext,
  ): Promise<void>;
  upload(
    local: string,
    remote: string,
    context?: TransferContext,
  ): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  deleteDirectory(path: string): Promise<void>;
}
export type LazyState =
  'UNKNOWN' | 'DISCOVERED' | 'LOADING' | 'MATERIALIZED' | 'ERROR';
export type FileState =
  | 'SYNCED'
  | 'PENDING'
  | 'UPLOADING'
  | 'DOWNLOADING'
  | 'ERROR'
  | 'CONFLICT'
  | 'REMOTE_ONLY'
  | 'OFFLINE';
export interface FileRecord {
  baseline: string | null;
  state: FileState;
  remote?: string | null;
  direction?: 'local' | 'remote';
}
export type OperationState =
  | 'PENDING'
  | 'RUNNING'
  | 'VERIFIED'
  | 'FAILED'
  | 'CONFLICT'
  | 'UNCERTAIN'
  | 'CANCELLED';
export function terminal(state: OperationState): boolean {
  return state === 'VERIFIED' || state === 'CANCELLED';
}
export interface Operation {
  id: string;
  connectionId: string;
  type: 'upload' | 'delete' | 'mkdir' | 'rmdir' | 'rename';
  path: string;
  destination?: string;
  state: OperationState;
  timestamp: string;
  attempts: number;
  error?: string;
  localVersion: string | null;
  baseline: string | null;
  tree?: Record<string, string | null>;
  retryable?: boolean;
  approved?: boolean;
}
export interface State {
  schema: 1;
  identity: string;
  files: Record<string, FileRecord>;
  directories: Record<string, LazyState>;
  operations: Operation[];
  lastSync?: string;
  inventory?: Record<string, RemoteEntry[]>;
}
export class SyncError extends Error {
  constructor(
    public code: 'CONFLICT' | 'UNCERTAIN' | 'SAFETY' | 'NETWORK' | 'CANCELLED',
    message: string,
  ) {
    super(message);
  }
}
export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncError('CANCELLED', 'Operation cancelled');
}
