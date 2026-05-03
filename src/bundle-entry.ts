import { PlaysVideoEngine } from './engine.js';
import { WasmFfmpegRunner } from './adapters/wasm-ffmpeg.js';
import { Source } from './source.js';
import { createCustomControls } from './custom-controls.js';

// Expose library on globalThis for WKWebView JS bridge access
Object.assign(globalThis, {
  PlaysVideo: {
    PlaysVideoEngine,
    WasmFfmpegRunner,
    Source,
    createCustomControls,
  },
});
