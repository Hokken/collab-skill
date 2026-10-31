// Collab Terminals: opens the named terminals that `collab-up` asks for.
// collab-up sends vscode://hokken.collab-terminals/up?cwd=<base64url>[&update=1]
// to the window whose integrated terminal ran it.
'use strict';

const vscode = require('vscode');

// The terminals to open, in order. `update` runs before the command with --update.
const TERMINALS = [
  { name: 'Claude code', command: 'claude', update: 'claude update' },
  { name: 'Codex', command: 'codex', update: 'codex update' },
  { name: 'collab watch', command: 'collab watch' },
  { name: 'collab note' },
];

// cmd.exe chains with '&'; PowerShell, bash, zsh and fish all take ';'.
const chain = (a, b) => (/cmd(\.exe)?$/i.test(vscode.env.shell || '') ? `${a} & ${b}` : `${a}; ${b}`);

function openTerminals(cwd, update) {
  let first;
  for (const t of TERMINALS) {
    const terminal = vscode.window.createTerminal({ name: t.name, cwd });
    if (t.command) terminal.sendText(update && t.update ? chain(t.update, t.command) : t.command);
    first = first || terminal;
  }
  first.show();
}

function activate(context) {
  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri(uri) {
      if (uri.path !== '/up') return;
      const params = new URLSearchParams(uri.query);
      const encoded = params.get('cwd');
      const cwd = encoded
        ? Buffer.from(encoded, 'base64url').toString('utf8')
        : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      openTerminals(cwd, params.get('update') === '1');
    },
  }));
}

function deactivate() {}

module.exports = { activate, deactivate };
