// Fetches the browser build of transformers.js that runs Whisper for "Transcribe
// voice message" (ui/whisper.js) into vendor/whisper. It is not kept in git (it
// is a 600 KB third-party bundle); this runs after `npm install`/`npm ci` and
// checks the file against its pinned SHA-256, so the build always ships this
// exact version. Update VERSION and SHA256 together with the onnxruntime-web
// devDependency (vendor/whisper/README.txt).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VERSION = '4.3.2';
const SHA256 = '8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb';
const URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${VERSION}/dist/transformers.min.js`;
const target = join(dirname(import.meta.dirname), 'vendor', 'whisper', 'transformers.min.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

if (existsSync(target) && hash(readFileSync(target)) === SHA256) process.exit(0);
const response = await fetch(URL).catch(error => ({ ok: false, statusText: error.message }));
if (!response.ok) { console.error(`fetch-whisper: could not download ${URL}: ${response.status || ''} ${response.statusText}`); process.exit(1); }
const bytes = Buffer.from(await response.arrayBuffer());
if (hash(bytes) !== SHA256) { console.error(`fetch-whisper: ${URL} is not the expected file (SHA-256 ${hash(bytes)})`); process.exit(1); }
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, bytes);
console.log(`fetch-whisper: transformers.js ${VERSION} saved to vendor/whisper`);
