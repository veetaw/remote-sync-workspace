import * as vscode from 'vscode';
import { htmlStartOffset } from './document-layout';

export async function splitPhpHtml(uri?: vscode.Uri): Promise<void> {
  const active = vscode.window.activeTextEditor;
  const target = uri ?? active?.document.uri;
  if (!target) return;
  const document =
    active?.document.uri.toString() === target.toString()
      ? active.document
      : await vscode.workspace.openTextDocument(target);
  const visible = vscode.window.visibleTextEditors
    .filter((e) => e.document === document)
    .sort((a, b) => (a.viewColumn ?? 1) - (b.viewColumn ?? 1));
  const source =
    visible[0] ??
    (await vscode.window.showTextDocument(document, { preview: false }));
  const offset = htmlStartOffset(document.getText());
  const destination =
    offset === undefined
      ? source.selection.active
      : document.positionAt(offset);
  const start = new vscode.Range(0, 0, 0, 0);
  if (offset !== undefined) {
    source.selection = new vscode.Selection(start.start, start.end);
    source.revealRange(start, vscode.TextEditorRevealType.AtTop);
  }
  // Reuse the existing second view when invoked again instead of accumulating groups.
  const right = await vscode.window.showTextDocument(document, {
    viewColumn: visible[1]?.viewColumn ?? vscode.ViewColumn.Beside,
    preview: false,
    selection: new vscode.Range(destination, destination),
    preserveFocus: false,
  });
  right.revealRange(
    new vscode.Range(destination, destination),
    vscode.TextEditorRevealType.AtTop,
  );
  if (offset === undefined)
    void vscode.window.showInformationMessage(
      'Remote Sync: no <html> tag found; opened a second view at the current position.',
    );
}
