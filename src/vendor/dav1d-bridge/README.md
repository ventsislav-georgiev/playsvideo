# dav1d bridge

Experimental local wasm wrapper for libdav1d built with 8-bit and 16-bit decode support.

The bridge returns contiguous 8-bit I420 frames. High-bit-depth I420 AV1 frames are downconverted by shifting samples down to 8-bit before they enter the existing WebCodecs H.264 encode path.

Build from the parent `personal` directory context so Docker can copy both `dav1d/` and `playsvideo/`:

```bash
docker buildx build \
  -f playsvideo/ffmpegbuild/Dockerfile.dav1d-bridge \
  -o playsvideo/ffmpegbuild/out-dav1d-bridge \
  .
cp playsvideo/ffmpegbuild/out-dav1d-bridge/dav1d-bridge.* playsvideo/src/vendor/dav1d-bridge/
```
