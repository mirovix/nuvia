// The speech recognizer behind "Transcribe voice message": Whisper small
// (multilingual, the language is detected) in transformers.js, running on this
// computer in a hidden window (whisper.html). The model is downloaded from
// Hugging Face the first time and kept in this window's cache. The page is
// cross-origin isolated (main.js serves it so), so the model uses several threads.
import { pipeline, env } from './transformers.min.js';

const MODEL = 'onnx-community/whisper-small';
const fake = new URLSearchParams(location.search).has('fake'); // tests: everything but the model
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL('./', location.href).href;
env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

let recognizer = null;
function load(id) {
  const files = new Map(); let sent = 0;
  const progress = info => {
    if (info.status !== 'progress' || !info.total) return;
    files.set(info.file, info);
    if (Date.now() - sent < 400) return;
    sent = Date.now();
    const all = [...files.values()];
    window.whisper.progress(id, Math.floor(100 * all.reduce((sum, file) => sum + file.loaded, 0) / all.reduce((sum, file) => sum + file.total, 0)));
  };
  recognizer ||= pipeline('automatic-speech-recognition', MODEL, { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, device: 'wasm', progress_callback: progress })
    .catch(error => { recognizer = null; throw error; });
  return recognizer;
}

// Any format Chromium plays (Ogg/Opus from WhatsApp and Telegram, MP3, AAC…),
// as Whisper wants it: mono, 16 kHz.
async function samples(bytes) {
  const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const data = decoded.getChannelData(channel);
    for (let index = 0; index < data.length; index++) mono[index] += data[index] / decoded.numberOfChannels;
  }
  return mono;
}

window.whisper.onJob(async ({ id, audio }) => {
  try {
    const mono = await samples(audio);
    const seconds = mono.length / 16000;
    if (fake) return window.whisper.reply(id, { text: `(test transcript, ${seconds.toFixed(1)} s)`, seconds });
    const recognize = await load(id);
    window.whisper.progress(id, 'transcribing');
    const result = await recognize(mono, { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    window.whisper.reply(id, { text: String(result.text || '').trim(), seconds });
  } catch (error) {
    window.whisper.reply(id, { error: error.message || String(error) });
  }
});
