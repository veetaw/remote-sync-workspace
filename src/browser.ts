import * as vscode from 'vscode';
import { Connection } from './types';
import { browserBaseUrl } from './browser-url';
import { relativePath } from './safety';

export async function configureBrowser(
  connection: Connection,
  save: (c: Connection) => Promise<void>,
): Promise<boolean> {
  const base = await vscode.window.showInputBox({
    title: `Browser — ${connection.name}: domain / base URL`,
    prompt:
      'Example: https://example.com/ or https://example.com/app/. Leave empty to disable browser links.',
    value: connection.webBaseUrl ?? '',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) return;
      try {
        browserBaseUrl(value.trim());
      } catch {
        return 'Use a complete HTTP/HTTPS URL without credentials, a query, or a fragment.';
      }
    },
  });
  if (base === undefined) return false;
  const webRoot = base.trim()
    ? await vscode.window.showInputBox({
        title: 'Web document root relative to the workspace',
        prompt:
          'Leave empty for the project root. Use public if the website serves only that directory.',
        value: connection.webRoot ?? '',
        ignoreFocusOut: true,
        validateInput: (value) => {
          try {
            relativePath(value.trim(), true);
          } catch {
            return 'Use a relative path with / and no traversal, for example public.';
          }
        },
      })
    : '';
  if (webRoot === undefined) return false;
  const next = {
    ...connection,
    webBaseUrl: base.trim() ? browserBaseUrl(base.trim()).href : undefined,
    webRoot: webRoot.trim(),
  };
  await save(next);
  Object.assign(connection, {
    webBaseUrl: next.webBaseUrl,
    webRoot: next.webRoot,
  });
  return true;
}
