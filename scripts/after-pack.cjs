// electron-builder hook. On Linux the castlabs Electron binary aborts in
// Chromium's zygote unless started with --no-zygote, which only works as a
// command-line flag (it runs before main.js). Wrap the executable so every
// package (AppImage, deb, rpm, tar.gz) and every launcher passes it.
const { renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const name = context.packager.executableName;
  const binary = join(context.appOutDir, name);
  renameSync(binary, `${binary}.bin`);
  writeFileSync(binary, `#!/bin/sh\nexec "$(dirname "$(readlink -f "$0")")/${name}.bin" --no-sandbox --no-zygote "$@"\n`, { mode: 0o755 });
};
