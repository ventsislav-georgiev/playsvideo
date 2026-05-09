import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../fixtures/codec-av1-opus.webm');
const DAV1D_WASM = resolve(__dirname, '../../node_modules/dav1d.js/dav1d.wasm');

test('dav1d/WebCodecs executor transcodes AV1 video and AAC audio to fragmented MP4', async ({
  page,
}) => {
  test.setTimeout(120_000);

  const [fixtureData, dav1dWasmData] = await Promise.all([
    readFile(FIXTURE),
    readFile(DAV1D_WASM),
  ]);

  await page.goto('/');

  const result = await page.evaluate(
    async ({ fixtureBytes, dav1dWasmBytes }) => {
      const [{ demuxBlob, collectPacketsInRange }, { WasmFfmpegRunner }, audioTranscode, dav1dTranscode] = await Promise.all([
        import('/src/pipeline/demux.ts'),
        import('/src/adapters/wasm-ffmpeg.ts'),
        import('/src/pipeline/audio-transcode.ts'),
        import('/src/pipeline/dav1d-video-transcode.ts'),
      ]);

      const { H264_WEB_CODECS_CODEC } = await import('/src/pipeline/webcodecs-transcode-probe.ts');
      const encoderSupport = await VideoEncoder.isConfigSupported({
        codec: H264_WEB_CODECS_CODEC,
        width: 1280,
        height: 720,
        bitrate: 2_800_000,
        framerate: 24,
        hardwareAcceleration: 'prefer-hardware',
        avc: { format: 'avc' },
      });
      if (!encoderSupport.supported) {
        return { skippedReason: 'Chromium does not expose H.264 WebCodecs encoding in this environment' };
      }

      const demux = await demuxBlob(new Blob([fixtureBytes], { type: 'video/webm' }));
      try {
        if (demux.videoCodec !== 'av1') {
          throw new Error(`Expected AV1 fixture, got ${demux.videoCodec}`);
        }
        if (demux.audioCodec !== 'opus') {
          throw new Error(`Expected Opus fixture audio, got ${demux.audioCodec ?? 'none'}`);
        }

        const videoPackets = await collectPacketsInRange(demux.videoSink, 0, 1, {
          startFromKeyframe: true,
        });
        const sourceAudioPackets = demux.audioSink
          ? await collectPacketsInRange(demux.audioSink, 0, 1)
          : [];
        if (videoPackets.length === 0) {
          throw new Error('No video packets collected from AV1 fixture');
        }
        if (sourceAudioPackets.length === 0) {
          throw new Error('No audio packets collected from AV1 fixture');
        }

        const ffmpeg = new WasmFfmpegRunner();
        await ffmpeg.loadForCodec('opus');
        const transcodeAudio = audioTranscode.createLocalAudioTranscoder(ffmpeg);
        const audioResult = await transcodeAudio({
          packets: sourceAudioPackets,
          sampleRate: demux.audioDecoderConfig?.sampleRate ?? 48_000,
          audioStartSec: sourceAudioPackets[0].timestamp,
          outputStartSec: 0,
          trimStartSec: 0,
          targetDurationSec: 1,
          sourceCodec: 'opus',
          audioDecoderConfig: demux.audioDecoderConfig,
        });
        if (audioResult.packets.length === 0) {
          throw new Error('Opus to AAC transcode produced no packets');
        }

        const transcodeVideo = dav1dTranscode.createDav1dWebCodecsVideoTranscoder({
          wasmData: dav1dWasmBytes.buffer,
        });
        const transcoded = await transcodeVideo({
          videoPackets,
          audioPackets: audioResult.packets,
          sourceVideoCodec: 'av1',
          sourceAudioCodec: 'aac',
          videoDecoderConfig: demux.videoDecoderConfig,
          audioDecoderConfig: audioResult.decoderConfig,
          segmentStartSec: 0,
          segmentDurationSec: 1,
          fragmentSequenceNumber: 1,
        });

        return {
          initBytes: transcoded.initSegment.byteLength,
          mediaBytes: transcoded.mediaData.byteLength,
          outputAudioCodec: transcoded.audioDecoderConfig?.codec ?? null,
          outputAudioSampleRate: transcoded.audioDecoderConfig?.sampleRate ?? null,
          inputVideoPackets: videoPackets.length,
          inputAudioPackets: sourceAudioPackets.length,
          outputAudioPackets: audioResult.packets.length,
          totalMs: transcoded.metrics.totalMs,
        };
      } finally {
        demux.dispose();
      }
    },
    {
      fixtureBytes: new Uint8Array(fixtureData),
      dav1dWasmBytes: new Uint8Array(dav1dWasmData),
    },
  );

  test.skip(Boolean(result.skippedReason), result.skippedReason ?? 'unsupported WebCodecs encoder');

  expect(result.initBytes).toBeGreaterThan(0);
  expect(result.mediaBytes).toBeGreaterThan(0);
  expect(result.outputAudioCodec).toBe('mp4a.40.2');
  expect(result.outputAudioSampleRate).toBeGreaterThan(0);
  expect(result.inputVideoPackets).toBeGreaterThan(0);
  expect(result.inputAudioPackets).toBeGreaterThan(0);
  expect(result.outputAudioPackets).toBeGreaterThan(0);
  expect(result.totalMs).toBeGreaterThan(0);
});
