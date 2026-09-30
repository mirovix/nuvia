import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, download, prepare } from '../../lib/update-install.js';

const posix = process.platform !== 'win32';

test('download streams to disk, reports progress and returns the SHA-256', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-'));
  const body = Buffer.from('new nuvia build');
  const progress = [];
  const fetchImpl = async () => new Response(body, { headers: { 'content-length': String(body.length) } });
  const hash = await download('https://example.test/x', join(dir, 'x.bin'), { fetchImpl, onProgress: p => progress.push(p) });
  assert.equal(hash, createHash('sha256').update(body).digest('hex'));
  assert.deepEqual(readFileSync(join(dir, 'x.bin')), body);
  assert.equal(progress.at(-1), 1);
  await assert.rejects(download('https://example.test/y', join(dir, 'y'), { fetchImpl: async () => new Response('no', { status: 404 }) }), /404/);
  rmSync(dir, { recursive: true, force: true });
});

test('a .tar.gz folder install is swapped for the new version, keeping the old one', { skip: !posix && 'tar layout test runs on Linux/macOS' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'upd-'));
  const target = join(root, 'Nuvia');
  mkdirSync(target);
  writeFileSync(join(target, 'version.txt'), '0.6.4');
  // Build a release archive shaped like electron-builder's: one top folder.
  const src = join(root, 'src', 'Nuvia-0.7.0-x64');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'version.txt'), '0.7.0');
  writeFileSync(join(src, 'nuvia-desktop'), '#!/bin/sh\n', { mode: 0o755 });
  const archive = join(root, 'Nuvia-0.7.0-x64.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', join(root, 'src'), 'Nuvia-0.7.0-x64']).status, 0);

  const staged = prepare('folder', { file: archive, target });
  assert.equal(readFileSync(join(target, 'version.txt'), 'utf8'), '0.6.4', 'prepare leaves the running install alone');
  const result = apply('folder', { ...staged, target, launcher: join(target, 'nuvia-desktop') });
  assert.equal(readFileSync(join(target, 'version.txt'), 'utf8'), '0.7.0');
  assert.equal(readFileSync(join(`${target}.old`, 'version.txt'), 'utf8'), '0.6.4');
  assert.equal(result.relaunch, join(target, 'nuvia-desktop'));
  assert.ok(statSync(join(target, 'nuvia-desktop')).mode & 0o100, 'still executable');
  rmSync(root, { recursive: true, force: true });
});

test('an AppImage is replaced in place and stays executable', { skip: !posix && 'POSIX modes' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'upd-'));
  const target = join(root, 'Nuvia.AppImage');
  writeFileSync(target, 'old', { mode: 0o755 });
  const file = join(root, 'download.AppImage');
  writeFileSync(file, 'new');
  const staged = prepare('appimage', { file, target });
  assert.equal(readFileSync(target, 'utf8'), 'old');
  assert.equal(apply('appimage', { ...staged, target }).relaunch, target);
  assert.equal(readFileSync(target, 'utf8'), 'new');
  assert.ok(statSync(target).mode & 0o100);
  assert.ok(!existsSync(`${target}.update`));
  rmSync(root, { recursive: true, force: true });
});

test('apply refuses when nothing was staged', () => {
  assert.throws(() => apply('folder', { staged: '/definitely/missing', target: '/tmp/x' }), /Nothing staged/);
});
