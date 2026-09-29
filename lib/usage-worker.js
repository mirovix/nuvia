// Scans session logs off the main thread; parsed files stay cached between requests.
import { parentPort } from 'node:worker_threads';
import { codexUsage, claudeUsage } from './usage.js';

parentPort.on('message', ({ id, codexRoot, claudeRoot }) => {
  try {
    parentPort.postMessage({ id, result: { codex: codexUsage({ root: codexRoot }), claude: claudeUsage({ root: claudeRoot }) } });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
