transformers.min.js is the browser build of @huggingface/transformers 4.3.2 (Apache-2.0, LICENSE-transformers.js).
It is not kept in git: scripts/fetch-whisper.mjs downloads it after `npm install` / `npm ci` and checks its SHA-256.
It runs ONNX Runtime Web 1.31.0-dev.20260914-8d85527a0, whose .wasm files come from the onnxruntime-web
devDependency of the same version (package.json build.extraResources). Update both together.
