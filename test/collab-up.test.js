'use strict';
// Run with: node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'collab-up.js');
const { packExtension, crc32 } = require(CLI);

// A fake `code` command first on PATH that records its arguments in args.txt.
function fakeCode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-up-test-'));
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'code.cmd'), '@echo %*> "%~dp0args.txt"\r\n');
  } else {
    fs.writeFileSync(path.join(dir, 'code'), '#!/bin/sh\nprintf "%s " "$@" > "$(dirname "$0")/args.txt"\n', { mode: 0o755 });
  }
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[key] = dir + path.delimiter + env[key];
  return { dir, env, args: () => fs.readFileSync(path.join(dir, 'args.txt'), 'utf8') };
}

const run = (args, { env = process.env, cwd } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('collab-up: rejects unknown and combined flags', () => {
  let r = run(['--bogus']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown argument: --bogus/);
  r = run(['--update', '--install']);
  assert.equal(r.code, 2);
  r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage: collab-up/);
});

test('collab-up: refuses to run outside a VS Code terminal', () => {
  const r = run([], { env: { ...process.env, TERM_PROGRAM: '', VSCODE_IPC_HOOK_CLI: '' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /VS Code integrated terminal/);
});

test('collab-up: sends the current folder and --update to the extension', () => {
  const code = fakeCode();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-up cwd '));
  const env = { ...code.env, TERM_PROGRAM: 'vscode', VSCODE_IPC_HOOK_CLI: '' };
  for (const [args, update] of [[[], false], [['--update'], true]]) {
    const r = run(args, { env, cwd });
    assert.equal(r.code, 0, r.err);
    const m = code.args().match(/--open-url"? "?vscode:\/\/hokken\.collab-terminals\/up\?([^"\s]+)/);
    assert.ok(m, code.args());
    const q = new URLSearchParams(m[1]);
    assert.equal(fs.realpathSync(Buffer.from(q.get('cwd'), 'base64url').toString('utf8')), fs.realpathSync(cwd));
    assert.equal(q.get('update'), update ? '1' : null);
  }
});

test('collab-up: --install hands a .vsix to code --install-extension', () => {
  const code = fakeCode();
  const r = run(['--install'], { env: code.env });
  assert.equal(r.code, 0, r.err);
  assert.match(code.args(), /--install-extension\S* \S*collab-terminals\.vsix\S* \S*--force/);
});

test('collab-up: packs the extension as a valid zip with a matching manifest', () => {
  const buf = packExtension();
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vscode', 'package.json'), 'utf8'));
  // Walk the central directory and check every entry against its local copy.
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const at = buf.readUInt32LE(p + 42);
    assert.equal(buf.readUInt32LE(at), 0x04034b50);
    const data = buf.subarray(at + 30 + buf.readUInt16LE(at + 26), at + 30 + buf.readUInt16LE(at + 26) + size);
    assert.equal(crc32(data), buf.readUInt32LE(p + 16), name);
    files[name] = data.toString('utf8');
    p += 46 + nameLen;
  }
  assert.deepEqual(Object.keys(files).sort(), [
    '[Content_Types].xml', 'extension.vsixmanifest',
    'extension/README.md', 'extension/extension.js', 'extension/package.json',
  ]);
  assert.match(files['extension.vsixmanifest'], new RegExp(`Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"`));
  // crc32 agrees with zlib's where Node has it (22.2+).
  if (zlib.crc32) assert.equal(crc32(Buffer.from('collab')), zlib.crc32('collab'));
});
