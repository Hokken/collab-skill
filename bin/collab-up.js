#!/usr/bin/env node
// collab-up — open the Claude code, Codex, collab watch and collab note
// terminals in the VS Code window whose integrated terminal runs it.
//
//   collab-up             open the four terminals in the current folder
//   collab-up --update    run `claude update` / `codex update` before starting them
//   collab-up --install   install (or update) the Collab Terminals VS Code extension
//
// The terminals are opened by the extension in ../vscode: this script sends it
// a vscode:// link through the `code` CLI. --install packs that folder into a
// .vsix (a zip, written here so there are still zero dependencies) and hands
// it to `code --install-extension`.
//
// Exit codes: 0 ok, 1 error, 2 bad usage. Zero dependencies (Node >= 18).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EXT_DIR = path.join(__dirname, '..', 'vscode');
const EXT_FILES = ['package.json', 'extension.js', 'README.md'];

const USAGE = `usage: collab-up [--update | --install]

  (no flag)    open the Claude code, Codex, collab watch and collab note terminals
  --update     run "claude update" and "codex update" before starting them
  --install    install or update the Collab Terminals VS Code extension

Run it from a VS Code integrated terminal. Setup: docs/vscode.md`;

// --- the code CLI -------------------------------------------------------------

// Windows needs a shell to find code.cmd; elsewhere run it directly.
function code(args) {
  const r = process.platform === 'win32'
    ? spawnSync(['code', ...args.map((a) => `"${a}"`)].join(' '), { shell: true, stdio: 'inherit' })
    : spawnSync('code', args, { stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') return 127;
  return r.status === null ? 1 : r.status;
}

const NO_CODE = 'the VS Code "code" command was not found. On macOS, run "Shell Command: '
  + 'Install \'code\' command in PATH" from the VS Code command palette.';

// --- .vsix packing --------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// zip([{ name, data }]) -> Buffer: an uncompressed (stored) zip archive.
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);           // version needed
    head.writeUInt16LE(0x0800, 6);       // utf-8 names
    head.writeUInt16LE(0, 8);            // stored
    head.writeUInt32LE(0x00210000, 10);  // 1980-01-01 00:00
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);            // version made by
    head.copy(dir, 6, 4, 30);            // shared fields: version needed .. name length
    dir.writeUInt32LE(offset, 42);
    local.push(head, n, data);
    central.push(dir, n);
    offset += head.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const xml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

// packExtension() -> Buffer: the vscode/ folder as a .vsix VS Code can install.
function packExtension() {
  const pkg = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8'));
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}" />
    <DisplayName>${xml(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(pkg.description)}</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;
  const types = '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension=".js" ContentType="application/javascript"/>'
    + '<Default Extension=".json" ContentType="application/json"/>'
    + '<Default Extension=".md" ContentType="text/markdown"/>'
    + '<Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>\n';
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(types) },
    { name: 'extension.vsixmanifest', data: Buffer.from(manifest) },
    ...EXT_FILES.map((f) => ({ name: `extension/${f}`, data: fs.readFileSync(path.join(EXT_DIR, f)) })),
  ]);
}

// --- commands -----------------------------------------------------------------

function install() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'collab-up-')), 'collab-terminals.vsix');
  fs.writeFileSync(file, packExtension());
  const status = code(['--install-extension', file, '--force']);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  if (status === 127) return fail(NO_CODE);
  if (status !== 0) return fail('installing the VS Code extension failed.');
  console.log('Reload open VS Code windows (Developer: Reload Window) to use collab-up there.');
  return 0;
}

function up(update) {
  // TERM_PROGRAM is set on every platform; VSCODE_IPC_HOOK_CLI only on macOS/Linux (and remotes).
  if (process.env.TERM_PROGRAM !== 'vscode' && !process.env.VSCODE_IPC_HOOK_CLI) {
    return fail('run this from a VS Code integrated terminal.');
  }
  let query = `cwd=${Buffer.from(process.cwd()).toString('base64url')}`;
  if (update) query += '&update=1';
  const status = code(['--open-url', `vscode://hokken.collab-terminals/up?${query}`]);
  if (status === 127) return fail(NO_CODE);
  return status === 0 ? 0 : fail('VS Code did not accept the link. Is the extension installed? (collab-up --install)');
}

function fail(msg) {
  console.error(`collab-up: ${msg}`);
  return 1;
}

function main(args) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  const unknown = args.filter((a) => a !== '--update' && a !== '--install');
  if (unknown.length || args.length > 1) {
    if (unknown.length) console.error(`collab-up: unknown argument: ${unknown[0]}`);
    console.error(USAGE);
    return 2;
  }
  return args[0] === '--install' ? install() : up(args[0] === '--update');
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { packExtension, crc32 };
