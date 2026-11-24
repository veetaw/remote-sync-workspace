export interface FileComparison {
  baseline: string | null;
  local: string | null;
  remote: string | null;
  checkedAt: string;
}
export type ComparisonState =
  'synced' | 'local' | 'remote' | 'conflict' | 'different';
export function comparisonState(
  result: FileComparison,
  dirty: boolean,
): ComparisonState {
  if (result.local === result.remote) return dirty ? 'local' : 'synced';
  const localChanged = dirty || result.local !== result.baseline;
  const remoteChanged = result.remote !== result.baseline;
  if (localChanged && remoteChanged) return 'conflict';
  if (remoteChanged) return 'remote';
  if (localChanged) return 'local';
  return 'different';
}
