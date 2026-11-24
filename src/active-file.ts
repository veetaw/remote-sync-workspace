import * as vscode from 'vscode';
import path from 'node:path';
import { SyncEngine } from './engine';
import { excluded } from './safety';
import { FileComparison, comparisonState } from './file-comparison';

export class ActiveFileIndicator implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    110,
  );
  private subscriptions: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;
  private key = '';
  private result?: FileComparison;
  private failure = false;
  private busy?: Promise<void>;
  private controller?: AbortController;
  private disposed = false;
  state = 'none';
  constructor(private engine: () => SyncEngine | undefined) {
    this.item.name = 'Remote Sync — file corrente';
    this.item.command = 'remoteSync.checkActiveFile';
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh(true)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) {
          // A clean document can be reloaded from an external disk write or undo.
          if (!e.document.isDirty && e.contentChanges.length) {
            this.result = undefined;
            this.schedule();
          }
          this.refresh();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document === vscode.window.activeTextEditor?.document) {
          this.result = undefined;
          this.refresh();
          this.schedule();
        }
      }),
      vscode.window.onDidChangeWindowState((e) => {
        if (e.focused) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('remoteSync.activeFileCheckSeconds'))
          this.startTimer();
      }),
    );
    this.startTimer();
    this.refresh(true);
  }
  private target():
    | {
        engine: SyncEngine;
        document: vscode.TextDocument;
        path: string;
        key: string;
      }
    | undefined {
    const engine = this.engine(),
      document = vscode.window.activeTextEditor?.document;
    if (!engine || !document || document.uri.scheme !== 'file') return;
    const relative = path
      .relative(engine.config.localRoot, document.uri.fsPath)
      .split(path.sep)
      .join('/');
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith('../') ||
      path.isAbsolute(relative) ||
      excluded(relative, engine.config.excludes)
    )
      return;
    return {
      engine,
      document,
      path: relative,
      key: `${engine.config.id}:${document.uri.toString()}`,
    };
  }
  private startTimer(): void {
    clearInterval(this.timer);
    const seconds = vscode.workspace
      .getConfiguration('remoteSync')
      .get('activeFileCheckSeconds', 15);
    this.timer = setInterval(
      () => {
        void this.check();
      },
      Math.max(5, seconds) * 1000,
    );
  }
  private schedule(): void {
    clearTimeout(this.debounce);
    if (!this.disposed)
      this.debounce = setTimeout(() => {
        void this.check();
      }, 750);
  }
  refresh(check = false): void {
    if (this.disposed) return;
    const key = this.target()?.key ?? '';
    if (key !== this.key) {
      this.controller?.abort();
      this.key = key;
      this.result = undefined;
      this.failure = false;
      if (key) this.schedule();
    }
    if (
      this.result &&
      (this.target()?.engine.store.state.files[this.target()!.path]?.baseline ??
        null) !== this.result.baseline
    ) {
      this.result = undefined;
      this.schedule();
    }
    if (check && key) this.schedule();
    this.render();
  }
  async check(): Promise<void> {
    if (this.disposed) return;
    this.refresh();
    const target = this.target();
    if (!target) return;
    if (this.busy) return this.busy;
    const controller = new AbortController();
    this.controller = controller;
    const key = target.key;
    // Assign busy before invoking the engine: transfer hooks synchronously refresh the UI.
    this.busy = Promise.resolve().then(async () => {
      try {
        const result = await target.engine.inspectFile(
          target.path,
          controller.signal,
        );
        if (!this.disposed && this.target()?.key === key) {
          this.result = result;
          this.failure = false;
        }
      } catch {
        if (
          !this.disposed &&
          this.target()?.key === key &&
          !controller.signal.aborted
        )
          this.failure = true;
      } finally {
        this.busy = undefined;
        if (!this.disposed) {
          this.render();
          if (this.target()?.key !== key) this.schedule();
        }
      }
    });
    this.render();
    return this.busy;
  }
  private render(): void {
    const target = this.target();
    if (!target) {
      this.state = 'none';
      this.item.hide();
      void vscode.commands.executeCommand(
        'setContext',
        'remoteSync.fileState',
        'none',
      );
      return;
    }
    this.state =
      this.failure ||
      (this.result && target.engine.connection.status === 'OFFLINE')
        ? 'error'
        : this.result
          ? comparisonState(this.result, target.document.isDirty)
          : this.busy
            ? 'checking'
            : 'unknown';
    const labels: Record<string, [string, string, string]> = {
      synced: ['circle-filled', 'Allineato', 'testing.iconPassed'],
      local: [
        'circle-filled',
        target.document.isDirty
          ? 'Modifiche locali non salvate'
          : 'Modifiche locali',
        'editorWarning.foreground',
      ],
      remote: [
        'circle-filled',
        'Modifiche sul server',
        'editorInfo.foreground',
      ],
      conflict: ['warning', 'Locale e server divergenti', 'errorForeground'],
      different: [
        'circle-filled',
        'Locale e server differenti',
        'editorWarning.foreground',
      ],
      checking: ['sync~spin', 'Controllo server…', 'descriptionForeground'],
      unknown: [
        'circle-outline',
        'Server non verificato',
        'descriptionForeground',
      ],
      error: [
        'circle-slash',
        'Controllo server non riuscito',
        'errorForeground',
      ],
    };
    const [icon, label, color] = labels[this.state];
    this.item.text = `$(${icon}) ${label}`;
    this.item.color = new vscode.ThemeColor(color);
    this.item.tooltip = `${target.path}\n${label}${this.busy ? '\nVerifica in corso…' : ''}\n${this.result ? `Ultimo controllo contenuto: ${new Date(this.result.checkedAt).toLocaleString()}` : 'Nessuna verifica del contenuto remoto disponibile.'}\n${this.result?.remote === null ? 'File assente sul server.\n' : ''}Clic per controllare adesso. Il controllo non pubblica né sostituisce file.`;
    this.item.accessibilityInformation = {
      label: `Remote Sync, ${label}, ${target.path}`,
    };
    this.item.show();
    void vscode.commands.executeCommand(
      'setContext',
      'remoteSync.fileState',
      this.state,
    );
  }
  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    this.controller?.abort();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.item.dispose();
  }
}
