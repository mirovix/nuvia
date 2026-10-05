// Downloads a release file and swaps it in. Separate from main.js so the file
// operations can be tested on plain folders (test/unit/update-install.test.js).
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

/**
 * Remove a folder of an Electron install.
 *
 * Inside a packaged app Electron patches `fs` so `app.asar` looks like a
 * directory: a recursive remove walks into it and fails with
 * "ENOTDIR: not a directory, rmdir .../resources/app.asar". `process.noAsar`
 * turns that off for the duration (outside Electron it is simply ignored).
 */
export function removeTree(target) {
  const previous = process.noAsar;
  process.noAsar = true;
  try { rmSync(target, { recursive: true, force: true }); } finally { process.noAsar = previous; }
}

/** Streams `url` to `file`, reporting progress (0..1). Returns the SHA-256. */
export async function download(url, file, { fetchImpl = fetch, onProgress = () => {}, userAgent = 'Nuvia' } = {}) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': userAgent } });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
  const total = Number(response.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  let got = 0;
  mkdirSync(dirname(file), { recursive: true });
  const meter = new Transform({ transform(chunk, _, done) { hash.update(chunk); got += chunk.length; if (total) onProgress(got / total); done(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(`${file}.part`));
  renameSync(`${file}.part`, file);
  return hash.digest('hex');
}

const run = (command, args) => {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 5 * 60 * 1000 });
  if (r.status !== 0) throw new Error(`${command} failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
};

/**
 * Unpacks the new version next to the installed one, ready to be swapped in.
 * Returns what apply() needs. Nothing of the running install is touched yet.
 */
export function prepare(kind, { file, target }) {
  if (kind === 'folder') {
    const staged = `${target}.update`;
    removeTree(staged);
    mkdirSync(staged, { recursive: true });
    run('tar', ['-xzf', file, '-C', staged, '--strip-components=1']);
    rmSync(file, { force: true });
    return { staged };
  }
  if (kind === 'appimage') {
    const staged = `${target}.update`;
    renameSync(file, staged);
    chmodSync(staged, 0o755);
    return { staged };
  }
  if (kind === 'mac') {
    const dir = join(dirname(target), '.nuvia-update');
    removeTree(dir);
    mkdirSync(dir, { recursive: true });
    run('ditto', ['-x', '-k', file, dir]);
    rmSync(file, { force: true });
    const app = readdirSync(dir).find(name => name.endsWith('.app'));
    if (!app) throw new Error('The update has no .app inside');
    // Unsigned app downloaded by us: skip Gatekeeper's "downloaded from the internet" prompt.
    spawnSync('xattr', ['-dr', 'com.apple.quarantine', join(dir, app)]);
    return { staged: join(dir, app), cleanup: dir };
  }
  return { staged: file }; // nsis / portable: the .exe itself
}

/**
 * Puts the staged version in place. `relaunch`: start the new version afterwards.
 * Returns the command to relaunch with (for folder/appimage/mac), or null.
 */
export function apply(kind, { staged, target, launcher, cleanup, relaunch = false, pid = process.pid }) {
  if (!staged || !existsSync(staged)) throw new Error('Nothing staged');
  if (kind === 'folder' || kind === 'mac') {
    const old = `${target}.old`;
    removeTree(old);
    renameSync(target, old); // the running process keeps its open files
    try { renameSync(staged, target); } catch (error) { renameSync(old, target); throw error; }
    if (cleanup) removeTree(cleanup);
    return { relaunch: kind === 'mac' ? join(target, 'Contents', 'MacOS', basename(target, '.app')) : launcher };
  }
  if (kind === 'appimage') {
    renameSync(staged, target);
    return { relaunch: target };
  }
  if (kind === 'nsis') {
    // Silent per-user install; --force-run starts Nuvia again when it is done.
    spawn(staged, ['/S', ...(relaunch ? ['--force-run'] : [])], { detached: true, stdio: 'ignore' }).unref();
    return { relaunch: null };
  }
  if (kind === 'portable') {
    // The running .exe is locked on Windows: replace it once this process has exited.
    const script = `$p = ${pid}; while (Get-Process -Id $p -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }; `
      + `Move-Item -Force -LiteralPath '${staged.replace(/'/g, "''")}' -Destination '${target.replace(/'/g, "''")}'`
      + (relaunch ? `; Start-Process -FilePath '${target.replace(/'/g, "''")}'` : '');
    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { relaunch: null };
  }
  throw new Error(`Cannot update a ${kind} install automatically`);
}
