// Map tiles for the commute map, fetched by the main process instead of the page.
// OpenStreetMap's tile policy asks for an identifying User-Agent, a Referer and
// local caching: requests from the page had none of these and were answered with
// "403 Access blocked". Tiles are cached on disk, and when a server refuses us the
// next one is used, so the map never shows error tiles.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROVIDERS = [
  { id: 'osm', url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png` },
  { id: 'osm-fr', url: (z, x, y) => `https://a.tile.openstreetmap.fr/hot/${z}/${x}/${y}.png` },
  { id: 'esri', url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}` },
];
const CACHE_MS = 14 * 24 * 3600 * 1000;
const BLOCKED_MS = 60 * 60 * 1000;

/** Parses nuvia-tile://t/{z}/{x}/{y}.png into numbers, or null if out of range. */
export function parseTileUrl(url) {
  const m = /^nuvia-tile:\/\/t\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/.exec(String(url));
  if (!m) return null;
  const [z, x, y] = m.slice(1).map(Number);
  const n = 2 ** z;
  return z <= 19 && x < n && y < n ? { z, x, y } : null;
}

const isImage = bytes => bytes.length > 8 && ((bytes[0] === 0x89 && bytes[1] === 0x50) || (bytes[0] === 0xff && bytes[1] === 0xd8));

export function createTileSource({ cacheDir, fetchImpl = fetch, userAgent, referer = 'https://github.com/mirovix/nuvia', now = () => Date.now() } = {}) {
  const blocked = new Map(); // provider id -> until
  return async function tile({ z, x, y }) {
    const file = join(cacheDir, `${z}-${x}-${y}.tile`);
    try { if (now() - statSync(file).mtimeMs < CACHE_MS) return readFileSync(file); } catch {}
    for (const provider of PROVIDERS) {
      if ((blocked.get(provider.id) || 0) > now()) continue;
      try {
        const response = await fetchImpl(provider.url(z, x, y), { headers: { 'User-Agent': userAgent, Referer: referer } });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (response.ok && isImage(bytes)) {
          try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(file, bytes); } catch {}
          return bytes;
        }
        if ([401, 403, 418, 429].includes(response.status)) blocked.set(provider.id, now() + BLOCKED_MS);
      } catch {}
    }
    // Offline: an old cached tile beats an empty square.
    try { return readFileSync(file); } catch { return null; }
  };
}
