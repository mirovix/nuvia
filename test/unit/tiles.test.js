import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTileSource, parseTileUrl } from '../../lib/tiles.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const reply = (status, body) => ({ ok: status === 200, status, arrayBuffer: async () => body });

test('tile urls are validated', () => {
  assert.deepEqual(parseTileUrl('nuvia-tile://t/10/545/361.png'), { z: 10, x: 545, y: 361 });
  assert.equal(parseTileUrl('nuvia-tile://t/2/4/0.png'), null);
  assert.equal(parseTileUrl('nuvia-tile://t/20/0/0.png'), null);
  assert.equal(parseTileUrl('nuvia-tile://t/../etc/passwd'), null);
});

test('OSM is asked with an identifying User-Agent and Referer, then cached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiles-'));
  const calls = [];
  const tile = createTileSource({ cacheDir: dir, userAgent: 'Nuvia/test', fetchImpl: async (url, opts) => { calls.push([url, opts.headers]); return reply(200, PNG); } });
  assert.deepEqual(await tile({ z: 10, x: 1, y: 2 }), PNG);
  assert.deepEqual(await tile({ z: 10, x: 1, y: 2 }), PNG);
  assert.equal(calls.length, 1, 'second request served from the disk cache');
  assert.match(calls[0][0], /tile\.openstreetmap\.org\/10\/1\/2\.png/);
  assert.equal(calls[0][1]['User-Agent'], 'Nuvia/test');
  assert.match(calls[0][1].Referer, /^https:\/\//);
  rmSync(dir, { recursive: true, force: true });
});

test('a blocked server (403 "Access blocked" tile) is skipped for the next ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiles-'));
  const hosts = [];
  const tile = createTileSource({ cacheDir: dir, userAgent: 'Nuvia/test', fetchImpl: async url => { hosts.push(new URL(url).host); return url.includes('tile.openstreetmap.org') ? reply(403, PNG) : reply(200, PNG); } });
  assert.deepEqual(await tile({ z: 5, x: 1, y: 1 }), PNG);
  await tile({ z: 5, x: 2, y: 1 });
  assert.deepEqual(hosts, ['tile.openstreetmap.org', 'a.tile.openstreetmap.fr', 'a.tile.openstreetmap.fr']);
  rmSync(dir, { recursive: true, force: true });
});

test('everything failing returns null instead of an error image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiles-'));
  const tile = createTileSource({ cacheDir: dir, userAgent: 'x', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await tile({ z: 1, x: 0, y: 0 }), null);
  rmSync(dir, { recursive: true, force: true });
});
