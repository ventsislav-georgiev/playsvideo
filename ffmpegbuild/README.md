# Custom ffmpeg.wasm Builds

The stock `@ffmpeg/core` is a 32 MB wasm binary with every codec imaginable.
We only use ffmpeg for audio transcode (non-MSE codecs → AAC), so we can ship
much smaller purpose-built bundles and load the right one based on what the
file actually needs.

## Bundle Strategy

| Bundle | Codecs | When loaded | ~Size |
|--------|--------|-------------|-------|
| *(none)* | AAC, MP3, Opus | MSE plays these natively — no ffmpeg needed | 0 |
| `ffmpeg-core-audio` | AC3/EAC3/DTS → AAC | Most movie files (DVD/Blu-ray rips) | ~2-5 MB |
| `ffmpeg-core` | Everything | Fallback for unusual codecs (FLAC in old browsers, etc.) | ~32 MB |
| `ffmpeg-core-av1` | AV1 → H.264/AAC (`libdav1d` + `libx264`) | Runtime reports AV1 cannot be appended to MSE/HLS | large |

The worker detects the audio codec at demux time and loads the smallest
sufficient bundle on demand. Most files are either AAC (no download) or
AC3 (tiny download). The full bundle is only fetched if something exotic
shows up.

## Building the Minimal Audio Bundle

Requires Docker 23.0+ with buildx.

```bash
# Build (first run ~30-60 min, subsequent builds much faster due to layer cache)
docker buildx build -f ffmpegbuild/Dockerfile.ffmpeg-audio -o ffmpegbuild/out .

# Or via the helper:
bash ffmpegbuild/build.sh audio

# Check the output size
ls -lh ffmpegbuild/out/

# Copy to vendor directory
mkdir -p src/vendor/ffmpeg-core-audio
cp ffmpegbuild/out/ffmpeg-core.{js,wasm} src/vendor/ffmpeg-core-audio/
```

## Building the AV1 Client Transcode Bundle

The stock `@ffmpeg/core` can parse AV1 containers, but it does not include a
software AV1 decoder in wasm. On iPhone that produces failures like
`hardware accelerated AV1 decoding`, `Function not implemented`, and
`Missing Sequence Header`. For client-only AV1 fallback, build the AV1 tier:

```bash
# First run is slow: this builds x264, dav1d, FFmpeg, and the wasm wrapper.
bash ffmpegbuild/build.sh av1

# Equivalent raw Docker command:
docker buildx build -f ffmpegbuild/Dockerfile.ffmpeg-av1 -o ffmpegbuild/out-av1 .
mkdir -p src/vendor/ffmpeg-core-av1
cp ffmpegbuild/out-av1/ffmpeg-core.{js,wasm} src/vendor/ffmpeg-core-av1/
```

`WasmFfmpegRunner.loadForCodec('av1')` loads `ffmpeg-core-av1` instead of the
stock full core. This keeps desktop Safari/Chrome on the fast remux path when
AV1 is supported, and only loads the heavy AV1 core when the runtime codec probe
requires video transcode.

## How the Build Works

The `Dockerfile.ffmpeg-audio` follows the same process as the upstream
[ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) project
but with two key differences:

1. **No external library stages** — the stock build compiles 14 separate
   libraries (x264, x265, libvpx, libmp3lame, libopus, libvorbis, libtheora,
   libogg, zlib, libwebp, freetype2, fribidi, harfbuzz, zimg). We need none
   of them because AC3/EAC3/DTS decoders and the AAC encoder are all native
   ffmpeg components.

2. **`--disable-everything`** — instead of the default full-featured ffmpeg,
   we start with nothing and selectively enable only:
   - Decoders: `ac3`, `eac3`, `dca` (DTS)
   - Encoder: `aac`
   - Demuxers: `ac3`, `eac3`, `dts`, `dtshd` (raw bitstream input)
   - Muxer: `adts` (AAC output)
   - Parsers, filters, swresample (minimal plumbing)

The final linking step uses the upstream ffmpegwasm C binding layer
(`src/bind/ffmpeg/`) to produce a wasm module compatible with the
`@ffmpeg/ffmpeg` v0.12.x JavaScript API — same `createFFmpegCore` export,
same FS interface, drop-in replacement.

## Versions

- Emscripten SDK: 3.1.40 (matches upstream)
- FFmpeg: n5.1.4 (matches upstream @ffmpeg/core 0.12.x)
- Target API: @ffmpeg/ffmpeg 0.12.15

## Adding More Codecs

To add support for another codec (e.g. FLAC decode), add the corresponding
`--enable-decoder=`, `--enable-demuxer=`, and `--enable-parser=` flags to
the configure step in `Dockerfile.ffmpeg-audio` and rebuild.

## Troubleshooting

- **Build fails at configure**: Make sure `--disable-asm` is present (no
  native asm in wasm) and threading is disabled for ST builds.
- **Build fails at link**: The fftools source files listed in the `emcc`
  command must match the ffmpeg version. If you change `FFMPEG_VERSION`,
  check that `fftools/*.c` filenames still exist.
- **Output doesn't work with @ffmpeg/ffmpeg**: The `EXPORTED_FUNCTIONS`
  and `EXPORTED_RUNTIME_METHODS` must match what the JS wrapper expects.
  We pull these from the upstream repo's `src/bind/ffmpeg/export*.js`.
