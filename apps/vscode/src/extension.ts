import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { Api, Store } from '@session-lens/core';

let store: Store | undefined;
let api: Api | undefined;

function getApi(): Api {
  if (!api) {
    const dirs = vscode.workspace.getConfiguration('sessionLens').get<string[]>('projectsDirs') ?? [];
    store = new Store(dirs.length ? { roots: dirs } : {});
    store.refresh(0);
    api = new Api(store);
  }
  return api;
}

/** The built dashboard, with asset URLs rewritten for the webview and a strict CSP. */
function dashboardHtml(ctx: vscode.ExtensionContext, webview: vscode.Webview): string {
  const uiDir = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'ui');
  const assets = webview.asWebviewUri(vscode.Uri.joinPath(uiDir, 'assets')).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return readFileSync(join(uiDir.fsPath, 'index.html'), 'utf8')
    .replace(/\.\/assets\//g, `${assets}/`)
    .replace(/ crossorigin/g, '')
    .replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);
}

/** Answers the dashboard's API calls and save requests over postMessage. */
function bridge(webview: vscode.Webview): vscode.Disposable {
  return webview.onDidReceiveMessage(async (m: { type: string; id?: number; path?: string; query?: string; body?: unknown; name?: string; content?: string }) => {
    if (m.type === 'api') {
      let body: unknown;
      try {
        body = getApi().handle(`/api/${m.path}`, new URLSearchParams(m.query ?? ''), m.body);
      } catch (e) {
        body = { error: String(e) };
      }
      void webview.postMessage({ type: 'api:result', id: m.id, body });
    } else if (m.type === 'save' && m.name && m.content != null) {
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(homedir(), m.name)) });
      if (uri) {
        writeFileSync(uri.fsPath, m.content);
        void vscode.window.showInformationMessage(`Saved ${uri.fsPath}`);
      }
    }
  });
}

function webviewOptions(ctx: vscode.ExtensionContext): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'ui')] };
}

let panel: vscode.WebviewPanel | undefined;

function openPanel(ctx: vscode.ExtensionContext, column: vscode.ViewColumn) {
  if (panel) {
    panel.reveal(column);
    return;
  }
  panel = vscode.window.createWebviewPanel('sessionLens', 'Session Lens', column, { ...webviewOptions(ctx), retainContextWhenHidden: true });
  panel.iconPath = new vscode.ThemeIcon('graph');
  panel.webview.html = dashboardHtml(ctx, panel.webview);
  const sub = bridge(panel.webview);
  panel.onDidDispose(() => {
    sub.dispose();
    panel = undefined;
  });
}

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sessionLens.open', () => openPanel(ctx, vscode.ViewColumn.Active)),
    vscode.commands.registerCommand('sessionLens.openBeside', () => openPanel(ctx, vscode.ViewColumn.Beside)),
    vscode.window.registerWebviewViewProvider(
      'sessionLens.view',
      {
        resolveWebviewView(view) {
          view.webview.options = webviewOptions(ctx);
          view.webview.html = dashboardHtml(ctx, view.webview);
          const sub = bridge(view.webview);
          view.onDidDispose(() => sub.dispose());
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sessionLens.projectsDirs')) api = undefined;
      if (e.affectsConfiguration('sessionLens.statusBar')) updateStatus();
    }),
  );

  // Status bar: today's estimated spend.
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'sessionLens.open';
  item.tooltip = 'Claude Code spend today (Session Lens). Click to open.';
  ctx.subscriptions.push(item);
  const updateStatus = () => {
    if (!vscode.workspace.getConfiguration('sessionLens').get<boolean>('statusBar', true)) {
      item.hide();
      return;
    }
    try {
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const s = getApi().summary({ from: today, to: today });
      item.text = `$(graph) $${s.totals.cost.toFixed(2)} today`;
      item.show();
    } catch {
      item.hide();
    }
  };
  updateStatus();
  const timer = setInterval(updateStatus, 60_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate() {}
