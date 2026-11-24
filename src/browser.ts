import * as vscode from 'vscode';
import { Connection } from './types';
import { browserBaseUrl } from './browser-url';
import { relativePath } from './safety';

export async function configureBrowser(
  connection: Connection,
  save: (c: Connection) => Promise<void>,
): Promise<boolean> {
  const base = await vscode.window.showInputBox({
    title: `Browser — ${connection.name}: dominio / URL base`,
    prompt:
      'Esempio: https://example.com/ oppure https://example.com/app/. Vuoto disabilita il collegamento.',
    value: connection.webBaseUrl ?? '',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) return;
      try {
        browserBaseUrl(value.trim());
      } catch {
        return 'URL HTTP/HTTPS completo, senza credenziali, query o frammenti.';
      }
    },
  });
  if (base === undefined) return false;
  const webRoot = base.trim()
    ? await vscode.window.showInputBox({
        title: 'Cartella web relativa al workspace',
        prompt:
          'Vuoto: root del progetto. Per esempio public se il sito espone soltanto la cartella public.',
        value: connection.webRoot ?? '',
        ignoreFocusOut: true,
        validateInput: (value) => {
          try {
            relativePath(value.trim(), true);
          } catch {
            return 'Percorso relativo con /, senza traversal; per esempio public.';
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
