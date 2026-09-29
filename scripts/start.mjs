// `npm start` on every OS. On Linux Chromium's zygote must be disabled from the
// command line (it starts before main.js runs), which also requires --no-sandbox.
import { spawn } from 'node:child_process';
import electron from 'electron';

const linux = process.platform === 'linux' ? ['--no-sandbox', '--no-zygote'] : [];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, ['.', ...linux, ...process.argv.slice(2)], { stdio: 'inherit', env })
  .on('exit', code => process.exit(code ?? 0));
