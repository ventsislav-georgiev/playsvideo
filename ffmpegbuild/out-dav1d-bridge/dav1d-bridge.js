export async function createDav1dBridge(options = {}) {
  const wasmData = options.wasmData;
  const wasmURL = options.wasmURL;
  if (!wasmData && !wasmURL) {
    throw new Error('createDav1dBridge requires wasmData or wasmURL');
  }

  const imports = {
    env: {
      abort: () => { throw new Error('dav1d bridge aborted'); },
      emscripten_notify_memory_growth: () => {},
      proc_exit: (code) => { throw new Error(`dav1d bridge exited with code ${code}`); },
    },
    wasi_snapshot_preview1: {
      proc_exit: (code) => { throw new Error(`dav1d bridge exited with code ${code}`); },
      fd_close: () => 0,
      fd_seek: () => 0,
      fd_write: () => 0,
    },
  };

  const source = wasmData
    ? wasmData
    : await fetch(wasmURL, { credentials: 'same-origin' }).then(async (res) => {
      if (!res.ok) throw new Error(`Failed to load dav1d bridge wasm: ${res.status} ${res.statusText}`);
      return res.arrayBuffer();
    });
  const { instance } = await WebAssembly.instantiate(source, imports);
  const exports = instance.exports;
  const memory = exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error('dav1d bridge wasm did not export memory');
  }

  const context = exports.djs_init();
  if (!context) {
    throw new Error('dav1d bridge failed to initialize decoder');
  }

  const heapU8 = () => new Uint8Array(memory.buffer);
  const heapU32 = () => new Uint32Array(memory.buffer);
  const heapI32 = () => new Int32Array(memory.buffer);

  const readFrame = (frameRef) => {
    const base32 = frameRef >>> 2;
    const u32 = heapU32();
    const i32 = heapI32();
    const status = i32[base32 + 6];
    const frame = {
      width: u32[base32],
      height: u32[base32 + 1],
      data: new Uint8Array(0),
      bitDepth: u32[base32 + 4],
      layout: u32[base32 + 5],
      status,
      downconverted: true,
    };
    if (status === 0) {
      const size = u32[base32 + 2];
      const dataRef = u32[base32 + 3];
      frame.data = heapU8().slice(dataRef, dataRef + size);
      exports.djs_free(dataRef);
    }
    exports.djs_free(frameRef);
    return frame;
  };

  return {
    decodeFrameAsYUV(data) {
      const input = data instanceof Uint8Array ? data : new Uint8Array(data);
      const inputRef = exports.djs_alloc_obu(input.byteLength);
      if (!inputRef) throw new Error('dav1d bridge failed to allocate input');
      try {
        heapU8().set(input, inputRef);
        const frameRef = exports.djs_decode_obu(context, inputRef, input.byteLength);
        if (!frameRef) throw new Error('dav1d bridge decode failed without frame info');
        const frame = readFrame(frameRef);
        if (frame.status === -2) throw new Error('dav1d bridge needs more data');
        if (frame.status === -3) throw new Error('dav1d bridge unsupported pixel layout');
        if (frame.status === -4) throw new Error('dav1d bridge unsupported bit depth');
        if (frame.status !== 0) throw new Error(`dav1d bridge decode failed status=${frame.status}`);
        return frame;
      } finally {
        exports.djs_free(inputRef);
      }
    },
    flush() {
      exports.djs_flush(context);
    },
    unsafeCleanup() {
      exports.djs_close(context);
    },
  };
}
