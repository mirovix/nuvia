// Automatic updates from GitHub Releases. Pure logic lives here (tested in
// test/unit/updater.test.js); main.js downloads and swaps the files.
//
// How each kind of install is updated:
//   appimage  Linux AppImage        the .AppImage file is replaced, then relaunched
//   folder    Linux .tar.gz folder  the folder is swapped for the new one (keeps a .old copy)
//   nsis      Windows installer     the new Setup runs silently and restarts Nuvia
//   portable  Windows portable .exe the .exe is replaced after Nuvia quits
//   mac       macOS .app            the .app bundle is swapped for the new one
//   package   .deb / .rpm           system-owned files: Nuvia only offers the download
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

export const REPO = 'mirovix/nuvia';
export const CHECK_EVERY_MS = 6 * 3600 * 1000;

/** 1.2.10 > 1.2.9; a "-beta" suffix is older than the plain version. */
export function isNewer(candidate, current) {
  const parse = v => String(v || '').replace(/^v/, '').split('-');
  const [a, preA] = parse(candidate);
  const [b, preB] = parse(current);
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return Boolean(preB) && !preA;
}

export function installKind({ platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  if (platform === 'linux') {
    if (env.APPIMAGE) return 'appimage';
    return /^\/(opt|usr)\//.test(execPath) ? 'package' : 'folder';
  }
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'nsis';
  if (platform === 'darwin') return 'mac';
  return 'package';
}

/** The release file that updates this kind of install, or null (manual download). */
export function pickAsset(assets = [], kind, { arch = process.arch } = {}) {
  const find = pattern => assets.find(asset => pattern.test(asset.name)) || null;
  switch (kind) {
    case 'appimage': return arch === 'x64' ? find(/\.AppImage$/) : null;
    case 'folder': return find(new RegExp(`-${arch}\\.tar\\.gz$`));
    case 'nsis': return find(/^Nuvia-Setup-.*\.exe$/);
    case 'portable': return find(/-portable\.exe$/);
    case 'mac': return find(new RegExp(`^Nuvia-[\\d.]+-${arch}\\.zip$`));
    default: return null;
  }
}

/** `sha256sum` output → { fileName: hash }. */
export function parseSums(text = '') {
  const sums = {};
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) sums[m[2].trim()] = m[1].toLowerCase();
  }
  return sums;
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Asks GitHub for the latest release. Returns null when there is nothing newer. */
export async function checkRelease({ current, kind, arch, fetchImpl = fetch, api = `https://api.github.com/repos/${REPO}/releases/latest` }) {
  const response = await fetchImpl(api, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Nuvia/${current}` } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const release = await response.json();
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!version || release.draft || release.prerelease || !isNewer(version, current)) return null;
  const assets = (release.assets || []).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size }));
  return {
    version,
    notes: String(release.body || '').slice(0, 4000),
    page: release.html_url || `https://github.com/${REPO}/releases/latest`,
    asset: pickAsset(assets, kind, { arch }),
    sums: assets.find(a => a.name === 'SHA256SUMS.txt') || null,
  };
}

/** Where things live for an install, from the running executable. */
export function installPaths(kind, { execPath = process.execPath, env = process.env } = {}) {
  if (kind === 'appimage') return { target: env.APPIMAGE, launcher: env.APPIMAGE };
  if (kind === 'folder') {
    // after-pack.cjs renames the real binary to <name>.bin behind a small wrapper script.
    const dir = dirname(execPath);
    return { target: dir, launcher: execPath.replace(/\.bin$/, '') };
  }
  if (kind === 'portable') return { target: env.PORTABLE_EXECUTABLE_FILE, launcher: env.PORTABLE_EXECUTABLE_FILE };
  if (kind === 'mac') {
    const app = execPath.includes('.app/') ? execPath.slice(0, execPath.indexOf('.app/') + 4) : null;
    return { target: app, launcher: app };
  }
  return { target: null, launcher: execPath };
}
