// electron-builder hook, run on every package before it is code-signed.
//
// Linux: the castlabs Electron binary aborts in Chromium's zygote unless
// started with --no-zygote, which only works as a command-line flag (it runs
// before main.js). Wrap the executable so every package (AppImage, deb, rpm,
// tar.gz) and every launcher passes it.
//
// Windows and macOS: Widevine plays protected music and video (Spotify) only in
// an app with a castlabs VMP signature; without it Spotify stops after a few
// seconds or cannot load the song. With NUVIA_VMP_SIGN=1 (the release workflow,
// signed in to castlabs EVS) the package is VMP-signed here and checked. This
// is before Apple's code signing, as macOS needs; on Windows VMP must come
// after Authenticode, which Nuvia does not use yet: if it ever does, move the
// Windows part to afterSign.
const { execFileSync } = require('node:child_process');
const { renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  if (platform === 'linux') {
    const name = context.packager.executableName;
    const binary = join(context.appOutDir, name);
    renameSync(binary, `${binary}.bin`);
    writeFileSync(binary, `#!/bin/sh\nexec "$(dirname "$(readlink -f "$0")")/${name}.bin" --no-sandbox --no-zygote "$@"\n`, { mode: 0o755 });
    return;
  }
  if ((platform === 'win32' || platform === 'darwin') && process.env.NUVIA_VMP_SIGN === '1') {
    const python = process.env.NUVIA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    execFileSync(python, ['-m', 'castlabs_evs.vmp', 'sign-pkg', context.appOutDir], { stdio: 'inherit' });
    execFileSync(python, ['-m', 'castlabs_evs.vmp', 'verify-pkg', context.appOutDir], { stdio: 'inherit' });
  }
};
