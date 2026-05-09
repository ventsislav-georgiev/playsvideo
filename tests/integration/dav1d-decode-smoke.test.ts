import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDav1dDecoder,
  decodeAv1PacketToSample,
  prepareDav1dAv1Packet,
} from '../../src/pipeline/dav1d-video-transcode.js';
import { collectPacketsInRange, demuxFile } from '../../src/pipeline/demux.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'codec-av1-opus.webm');
const DAV1D_WASM = join(import.meta.dirname, '..', '..', 'node_modules', 'dav1d.js', 'dav1d.wasm');
const DAV1D_BRIDGE_WASM = join(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'vendor',
  'dav1d-bridge',
  'dav1d-bridge.wasm',
);

describe('dav1d decode smoke', () => {
  it('prepends AV1 config OBUs only for decoder initialization packets missing a sequence header', () => {
    // OBU headers: type 1 (sequence header) with size field = (1 << 3) | 0x02 = 0x0a
    // OBU headers: type 6 (frame) with size field = (6 << 3) | 0x02 = 0x32
    const seqHeaderObu = new Uint8Array([0x0a, 0x01, 0x00]);
    const frameObu = new Uint8Array([0x32, 0x01, 0x00]);
    const av1Description = new Uint8Array([0x81, 0x00, 0x00, 0x00, ...seqHeaderObu]);
    const decoderConfig: VideoDecoderConfig = {
      codec: 'av01.0.08M.08',
      codedWidth: 16,
      codedHeight: 16,
      description: av1Description,
    };

    expect(prepareDav1dAv1Packet(frameObu, decoderConfig, false)).toBe(frameObu);
    expect(prepareDav1dAv1Packet(seqHeaderObu, decoderConfig, true)).toBe(seqHeaderObu);

    const prepared = prepareDav1dAv1Packet(frameObu, decoderConfig, true);
    expect(prepared).not.toBe(frameObu);
    expect([...prepared]).toEqual([...seqHeaderObu, ...frameObu]);
  });

  it('reads AV1 config OBUs from ArrayBufferView descriptions with byte offsets', () => {
    const seqHeaderObu = new Uint8Array([0x0a, 0x01, 0x00]);
    const frameObu = new Uint8Array([0x32, 0x01, 0x00]);
    const backing = new Uint8Array([0xff, 0xff, 0x81, 0x00, 0x00, 0x00, ...seqHeaderObu, 0xff]);
    const decoderConfig: VideoDecoderConfig = {
      codec: 'av01.0.08M.08',
      codedWidth: 16,
      codedHeight: 16,
      description: new DataView(backing.buffer, 2, 4 + seqHeaderObu.byteLength),
    };

    const prepared = prepareDav1dAv1Packet(frameObu, decoderConfig, true);
    expect([...prepared]).toEqual([...seqHeaderObu, ...frameObu]);
  });

  it('decodes the first AV1 packet collected by the existing segment pipeline', async () => {
    const demux = await demuxFile(FIXTURE);
    expect(demux.videoCodec).toBe('av1');

    const packets = await collectPacketsInRange(demux.videoSink, 0, 1, { startFromKeyframe: true });
    expect(packets.length).toBeGreaterThan(0);

    const decoder = await createDav1dDecoder(await readFile(DAV1D_WASM));
    const { sample } = decodeAv1PacketToSample(decoder, packets[0], demux.videoDecoderConfig, true);

    expect(sample.format).toBe('I420');
    expect(sample.codedWidth).toBe(demux.videoDecoderConfig.codedWidth);
    expect(sample.codedHeight).toBe(demux.videoDecoderConfig.codedHeight);
    expect(sample.timestamp).toBe(packets[0].timestamp);
    expect(sample.duration).toBe(packets[0].duration);
    sample.close();
  }, 30_000);

  it('decodes the first AV1 packet with the downconverting dav1d bridge wasm', async () => {
    const demux = await demuxFile(FIXTURE);
    const packets = await collectPacketsInRange(demux.videoSink, 0, 1, { startFromKeyframe: true });

    const decoder = await createDav1dDecoder(await readFile(DAV1D_BRIDGE_WASM));
    const { frame, sample } = decodeAv1PacketToSample(decoder, packets[0], demux.videoDecoderConfig, true);

    expect(frame.downconverted).toBe(true);
    expect(frame.bitDepth).toBe(8);
    expect(sample.format).toBe('I420');
    expect(sample.codedWidth).toBe(demux.videoDecoderConfig.codedWidth);
    expect(sample.codedHeight).toBe(demux.videoDecoderConfig.codedHeight);
    sample.close();
  }, 30_000);
});
