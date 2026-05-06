import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EncodedPacket } from 'mediabunny';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/adapters/node-ffmpeg.js';
import { NodeFfprobeRunner } from '../../src/adapters/node-ffprobe.js';
import { collectPacketsInRange, demuxFile } from '../../src/pipeline/demux.js';
import { muxToFmp4 } from '../../src/pipeline/mux.js';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');
const ffprobe = new NodeFfprobeRunner();

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function readBoxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset + 4],
    bytes[offset + 5],
    bytes[offset + 6],
    bytes[offset + 7],
  );
}

function findChildBox(bytes: Uint8Array, parentOffset: number, type: string): number | null {
  const parentSize = readU32(bytes, parentOffset);
  let offset = parentOffset + 8;
  const end = parentOffset + parentSize;

  while (offset + 8 <= end) {
    const size = readU32(bytes, offset);
    if (size < 8 || offset + size > end) return null;
    if (readBoxType(bytes, offset) === type) return offset;
    offset += size;
  }

  return null;
}

function readFragmentSequenceNumber(media: Uint8Array): number {
  expect(readBoxType(media, 0)).toBe('moof');
  const mfhdOffset = findChildBox(media, 0, 'mfhd');
  expect(mfhdOffset).not.toBeNull();
  return readU32(media, mfhdOffset! + 12);
}

describe('mux', () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it('muxes video+aac packets into decodable fMP4', async () => {
    const demux = await demuxFile(join(FIXTURES_DIR, 'test-h264-aac.mp4'));
    dispose = demux.dispose;

    const videoPackets = await collectPacketsInRange(demux.videoSink, 0, 10);
    const audioPackets = await collectPacketsInRange(demux.audioSink!, 0, 10);

    expect(videoPackets.length).toBeGreaterThan(0);
    expect(audioPackets.length).toBeGreaterThan(0);

    const result = await muxToFmp4({
      videoPackets,
      audioPackets,
      videoCodec: demux.videoCodec,
      audioCodec: demux.audioCodec!,
      videoDecoderConfig: demux.videoDecoderConfig,
      audioDecoderConfig: demux.audioDecoderConfig,
    });

    expect(result.init.byteLength).toBeGreaterThan(0);
    expect(result.media).toHaveLength(1);

    // Write init + all media to a file and verify decodable
    const tempDir = await makeTempDir();
    const totalMediaSize = result.media.reduce((s, m) => s + m.byteLength, 0);
    const combined = new Uint8Array(result.init.byteLength + totalMediaSize);
    combined.set(result.init, 0);
    let offset = result.init.byteLength;
    for (const media of result.media) {
      combined.set(media, offset);
      offset += media.byteLength;
    }

    const outPath = join(tempDir, 'test-output.mp4');
    await writeFile(outPath, combined);

    const decodable = await ffprobe.verifyDecodable(outPath);
    expect(decodable.ok, `Not decodable: ${decodable.stderr}`).toBe(true);

    const probe = await ffprobe.probe(outPath);
    const videoStream = probe.streams.find((s) => s.codecType === 'video');
    const audioStream = probe.streams.find((s) => s.codecType === 'audio');
    expect(videoStream?.codecName).toBe('h264');
    expect(audioStream?.codecName).toBe('aac');
  });

  it('can seed mfhd sequence numbers for independently muxed HLS segments', async () => {
    const demux = await demuxFile(join(FIXTURES_DIR, 'test-h264-aac.mp4'));
    dispose = demux.dispose;

    const videoPackets = await collectPacketsInRange(demux.videoSink, 0, 3);
    const audioPackets = await collectPacketsInRange(demux.audioSink!, 0, 3);

    const first = await muxToFmp4({
      videoPackets,
      audioPackets,
      videoCodec: demux.videoCodec,
      audioCodec: demux.audioCodec!,
      videoDecoderConfig: demux.videoDecoderConfig,
      audioDecoderConfig: demux.audioDecoderConfig,
      fragmentSequenceNumber: 4,
    });
    const second = await muxToFmp4({
      videoPackets,
      audioPackets,
      videoCodec: demux.videoCodec,
      audioCodec: demux.audioCodec!,
      videoDecoderConfig: demux.videoDecoderConfig,
      audioDecoderConfig: demux.audioDecoderConfig,
      fragmentSequenceNumber: 5,
    });

    expect(first.media.length).toBeGreaterThan(0);
    expect(second.media.length).toBeGreaterThan(0);
    expect(first.media).toHaveLength(1);
    expect(second.media).toHaveLength(1);
    expect(readFragmentSequenceNumber(first.media[0])).toBe(4);
    expect(readFragmentSequenceNumber(second.media[0])).toBe(5);
  });

  it('brands AV1 fragmented MP4 init segments with AV1 sample config', async () => {
    const av1Description = new Uint8Array([0x81, 0x00, 0x0c, 0x00, 0x0a]);
    const result = await muxToFmp4({
      videoPackets: [new EncodedPacket(new Uint8Array([0x12, 0x00, 0x0a]), 'key', 0, 1 / 24)],
      audioPackets: [new EncodedPacket(new Uint8Array([0x00]), 'key', 0, 1024 / 48000)],
      videoCodec: 'av1',
      audioCodec: 'aac',
      videoDecoderConfig: {
        codec: 'av01.0.08M.08',
        codedWidth: 16,
        codedHeight: 16,
        description: av1Description,
      },
      audioDecoderConfig: {
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        numberOfChannels: 2,
        description: new Uint8Array([0x11, 0x90]),
      },
    });

    expect(result.debugSummary).toContain('av01');
    expect(result.debugSummary).toContain('av01=1');
    expect(result.debugSummary).toContain(`av1C=${8 + av1Description.byteLength}b`);
  });

  it('rejects audio packets without decoder config', async () => {
    await expect(
      muxToFmp4({
        videoPackets: [new EncodedPacket(new Uint8Array([0x12, 0x00, 0x0a]), 'key', 0, 1 / 24)],
        audioPackets: [new EncodedPacket(new Uint8Array([0x00]), 'key', 0, 1024 / 48000)],
        videoCodec: 'av1',
        audioCodec: 'aac',
        videoDecoderConfig: {
          codec: 'av01.0.08M.08',
          codedWidth: 16,
          codedHeight: 16,
          description: new Uint8Array([0x81, 0x00, 0x0c, 0x00, 0x0a]),
        },
        audioDecoderConfig: null,
      }),
    ).rejects.toThrow('Cannot mux audio codec aac without decoder config');
  });
});
