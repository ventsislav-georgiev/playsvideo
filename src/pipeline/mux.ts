import {
  type AudioCodec,
  EncodedAudioPacketSource,
  type EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  NullTarget,
  Output,
  type VideoCodec,
} from 'mediabunny';

export interface MuxInput {
  videoPackets: EncodedPacket[];
  audioPackets: EncodedPacket[];
  videoCodec: string;
  audioCodec: string;
  videoDecoderConfig: VideoDecoderConfig;
  audioDecoderConfig: AudioDecoderConfig | null;
  fragmentSequenceNumber?: number;
}

export interface MuxResult {
  init: Uint8Array;
  media: Uint8Array[];
  debugSummary: string;
}

// Keep each logical HLS segment as a single fMP4 moof/mdat pair. Smaller
// values let Mediabunny split long segments into multiple internal fragments,
// which hls.js can mishandle after seeks when appending passthrough fMP4.
const SINGLE_HLS_FRAGMENT_DURATION_SEC = Number.MAX_SAFE_INTEGER;

function concatBuffers(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.byteLength;
  }
  return result;
}

function readU32(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.byteLength) return null;
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

function readBoxType(bytes: Uint8Array, offset: number): string | null {
  if (offset < 0 || offset + 8 > bytes.byteLength) return null;
  return String.fromCharCode(
    bytes[offset + 4],
    bytes[offset + 5],
    bytes[offset + 6],
    bytes[offset + 7],
  );
}

function boxHeaderSize(bytes: Uint8Array, offset: number): number | null {
  const size = readU32(bytes, offset);
  if (size === null) return null;
  if (size === 1) return 16;
  if (size >= 8) return 8;
  return null;
}

function boxSize(bytes: Uint8Array, offset: number, limit: number): number | null {
  const size = readU32(bytes, offset);
  if (size === null) return null;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    const largeSize = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 8).getBigUint64(0);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(largeSize);
  }
  if (size === 0) return limit - offset;
  return size;
}

function findChildBox(bytes: Uint8Array, parentOffset: number, targetType: string): number | null {
  const parentSize = boxSize(bytes, parentOffset, bytes.byteLength);
  const parentHeaderSize = boxHeaderSize(bytes, parentOffset);
  if (parentSize === null || parentHeaderSize === null) return null;

  const parentEnd = Math.min(bytes.byteLength, parentOffset + parentSize);
  let offset = parentOffset + parentHeaderSize;
  while (offset + 8 <= parentEnd) {
    const size = boxSize(bytes, offset, parentEnd);
    const type = readBoxType(bytes, offset);
    if (size === null || size < 8 || offset + size > parentEnd) return null;
    if (type === targetType) return offset;
    offset += size;
  }

  return null;
}

function findChildBoxes(bytes: Uint8Array, parentOffset: number, targetType: string): number[] {
  const parentSize = boxSize(bytes, parentOffset, bytes.byteLength);
  const parentHeaderSize = boxHeaderSize(bytes, parentOffset);
  if (parentSize === null || parentHeaderSize === null) return [];

  const parentEnd = Math.min(bytes.byteLength, parentOffset + parentSize);
  const offsets: number[] = [];
  let offset = parentOffset + parentHeaderSize;
  while (offset + 8 <= parentEnd) {
    const size = boxSize(bytes, offset, parentEnd);
    const type = readBoxType(bytes, offset);
    if (size === null || size < 8 || offset + size > parentEnd) return offsets;
    if (type === targetType) offsets.push(offset);
    offset += size;
  }

  return offsets;
}

function readU64(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 8 > bytes.byteLength) return null;
  const value = new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

function readFullBoxFlags(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 12 > bytes.byteLength) return null;
  return (bytes[offset + 9] << 16) | (bytes[offset + 10] << 8) | bytes[offset + 11];
}

function readBoxVersion(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 9 > bytes.byteLength) return null;
  return bytes[offset + 8];
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string | null {
  if (offset < 0 || offset + length > bytes.byteLength) return null;
  let result = '';
  for (let i = 0; i < length; i++) result += String.fromCharCode(bytes[offset + i]);
  return result;
}

function findBoxesDeep(
  bytes: Uint8Array,
  offset: number,
  targetType: string,
  limit = bytes.byteLength,
): number[] {
  const offsets: number[] = [];
  let cursor = offset;
  while (cursor + 8 <= limit) {
    const size = boxSize(bytes, cursor, limit);
    const type = readBoxType(bytes, cursor);
    if (size === null || size < 8 || cursor + size > limit) break;
    if (type === targetType) offsets.push(cursor);
    const headerSize = boxHeaderSize(bytes, cursor) ?? 8;
    offsets.push(...findBoxesDeep(bytes, cursor + headerSize, targetType, cursor + size));
    cursor += size;
  }
  return offsets;
}

function findBoxChildrenInRange(
  bytes: Uint8Array,
  start: number,
  limit: number,
  targetType: string,
): number[] {
  const offsets: number[] = [];
  let cursor = start;
  while (cursor + 8 <= limit) {
    const size = boxSize(bytes, cursor, limit);
    const type = readBoxType(bytes, cursor);
    if (size === null || size < 8 || cursor + size > limit) break;
    if (type === targetType) offsets.push(cursor);
    cursor += size;
  }
  return offsets;
}

function findVisualSampleEntries(bytes: Uint8Array, codecBoxType: string): number[] {
  const entries: number[] = [];
  for (const stsdOffset of findBoxesDeep(bytes, 0, 'stsd')) {
    const entryCount = readU32(bytes, stsdOffset + 12) ?? 0;
    const stsdSize = boxSize(bytes, stsdOffset, bytes.byteLength);
    if (stsdSize === null) continue;

    const stsdEnd = Math.min(bytes.byteLength, stsdOffset + stsdSize);
    let cursor = stsdOffset + 16;
    for (let i = 0; i < entryCount && cursor + 8 <= stsdEnd; i++) {
      const size = boxSize(bytes, cursor, stsdEnd);
      const type = readBoxType(bytes, cursor);
      if (size === null || size < 8 || cursor + size > stsdEnd) break;
      if (type === codecBoxType) entries.push(cursor);
      cursor += size;
    }
  }
  return entries;
}

function findAv1ConfigurationBoxes(init: Uint8Array): number[] {
  return findVisualSampleEntries(init, 'av01').flatMap((sampleEntryOffset) => {
    const sampleEntrySize = boxSize(init, sampleEntryOffset, init.byteLength);
    if (sampleEntrySize === null) return [];

    const sampleEntryEnd = Math.min(init.byteLength, sampleEntryOffset + sampleEntrySize);
    const visualSampleEntryHeaderSize = 8 + 78;
    return findBoxChildrenInRange(
      init,
      sampleEntryOffset + visualSampleEntryHeaderSize,
      sampleEntryEnd,
      'av1C',
    );
  });
}

function parseTrackId(bytes: Uint8Array, trakOffset: number): number | null {
  const tkhdOffset = findChildBox(bytes, trakOffset, 'tkhd');
  if (tkhdOffset === null) return null;
  const version = readBoxVersion(bytes, tkhdOffset);
  if (version === 1) return readU32(bytes, tkhdOffset + 28);
  return readU32(bytes, tkhdOffset + 20);
}

function parseTrackHandler(bytes: Uint8Array, trakOffset: number): string | null {
  const mdiaOffset = findChildBox(bytes, trakOffset, 'mdia');
  if (mdiaOffset === null) return null;
  const hdlrOffset = findChildBox(bytes, mdiaOffset, 'hdlr');
  if (hdlrOffset === null) return null;
  return readAscii(bytes, hdlrOffset + 16, 4);
}

function describeInitForDebug(init: Uint8Array): string {
  const ftypOffset = readBoxType(init, 0) === 'ftyp' ? 0 : null;
  const brands: string[] = [];
  if (ftypOffset !== null) {
    const size = boxSize(init, ftypOffset, init.byteLength) ?? 0;
    const major = readAscii(init, ftypOffset + 8, 4);
    if (major) brands.push(`major=${major}`);
    for (let offset = ftypOffset + 16; offset + 4 <= ftypOffset + size; offset += 4) {
      const brand = readAscii(init, offset, 4);
      if (brand) brands.push(brand);
    }
  }

  const moovOffset = findBoxesDeep(init, 0, 'moov')[0] ?? null;
  const tracks: string[] = [];
  if (moovOffset !== null) {
    for (const trakOffset of findChildBoxes(init, moovOffset, 'trak')) {
      const id = parseTrackId(init, trakOffset);
      const handler = parseTrackHandler(init, trakOffset) ?? '?';
      tracks.push(`${handler}:${id ?? '?'}`);
    }
  }

  const av01Entries = findVisualSampleEntries(init, 'av01');
  const av1C = findAv1ConfigurationBoxes(init)[0] ?? null;
  const av1CBytes = av1C === null ? 'none' : `${boxSize(init, av1C, init.byteLength) ?? '?'}b`;
  return `init brands=[${brands.join(',') || 'none'}] tracks=[${tracks.join(',') || 'none'}] av01=${av01Entries.length} av1C=${av1CBytes}`;
}

function describeTrunForDebug(bytes: Uint8Array, trunOffset: number): string {
  const flags = readFullBoxFlags(bytes, trunOffset) ?? 0;
  const sampleCount = readU32(bytes, trunOffset + 12) ?? 0;
  let cursor = trunOffset + 16;
  if ((flags & 0x1) !== 0) cursor += 4;
  const firstSampleFlags = (flags & 0x4) !== 0 ? readU32(bytes, cursor) : null;
  if ((flags & 0x4) !== 0) cursor += 4;

  const firstSampleDuration =
    (flags & 0x100) !== 0 && sampleCount > 0 ? readU32(bytes, cursor) : null;
  return `trun samples=${sampleCount} flags=0x${flags.toString(16)} firstFlags=${firstSampleFlags === null ? 'none' : `0x${firstSampleFlags.toString(16)}`} firstDur=${firstSampleDuration ?? 'default'}`;
}

function describeTrafForDebug(bytes: Uint8Array, trafOffset: number): string {
  const tfhdOffset = findChildBox(bytes, trafOffset, 'tfhd');
  const tfdtOffset = findChildBox(bytes, trafOffset, 'tfdt');
  const trunOffset = findChildBox(bytes, trafOffset, 'trun');

  const tfhdFlags = tfhdOffset === null ? 0 : (readFullBoxFlags(bytes, tfhdOffset) ?? 0);
  const trackId = tfhdOffset === null ? null : readU32(bytes, tfhdOffset + 12);
  let cursor = tfhdOffset === null ? 0 : tfhdOffset + 16;
  if ((tfhdFlags & 0x1) !== 0) cursor += 8;
  if ((tfhdFlags & 0x2) !== 0) cursor += 4;
  const defaultDuration = (tfhdFlags & 0x8) !== 0 ? readU32(bytes, cursor) : null;
  if ((tfhdFlags & 0x8) !== 0) cursor += 4;
  if ((tfhdFlags & 0x10) !== 0) cursor += 4;
  const defaultFlags = (tfhdFlags & 0x20) !== 0 ? readU32(bytes, cursor) : null;

  const tfdtVersion = tfdtOffset === null ? null : readBoxVersion(bytes, tfdtOffset);
  const tfdt =
    tfdtOffset === null
      ? null
      : tfdtVersion === 1
        ? readU64(bytes, tfdtOffset + 12)
        : readU32(bytes, tfdtOffset + 12);
  const trun = trunOffset === null ? 'trun=missing' : describeTrunForDebug(bytes, trunOffset);

  return `track=${trackId ?? '?'} tfdt=${tfdt ?? '?'} tfhdFlags=0x${tfhdFlags.toString(16)} defaultDur=${defaultDuration ?? 'none'} defaultFlags=${defaultFlags === null ? 'none' : `0x${defaultFlags.toString(16)}`} ${trun}`;
}

function describeMediaForDebug(media: Uint8Array[]): string {
  return media
    .map((part, index) => {
      const moofOffset =
        readBoxType(part, 0) === 'moof' ? 0 : (findBoxesDeep(part, 0, 'moof')[0] ?? null);
      if (moofOffset === null) return `part${index}:moof=missing bytes=${part.byteLength}`;
      const trafs = findChildBoxes(part, moofOffset, 'traf').map((traf) =>
        describeTrafForDebug(part, traf),
      );
      return `part${index}:bytes=${part.byteLength} ${trafs.join(' | ') || 'traf=none'}`;
    })
    .join(' ; ');
}

function withFragmentSequenceNumber(moof: Uint8Array, sequenceNumber: number): Uint8Array {
  if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1 || sequenceNumber > 0xffffffff) {
    return moof;
  }

  const moofType = readBoxType(moof, 0);
  if (moofType !== 'moof') return moof;

  const mfhdOffset = findChildBox(moof, 0, 'mfhd');
  if (mfhdOffset === null || mfhdOffset + 16 > moof.byteLength) return moof;

  const patched = new Uint8Array(moof);
  new DataView(patched.buffer, patched.byteOffset + mfhdOffset + 12, 4).setUint32(
    0,
    sequenceNumber,
  );
  return patched;
}

export async function muxToFmp4(input: MuxInput): Promise<MuxResult> {
  const initParts: Uint8Array[] = [];
  const moofMdatPairs: Uint8Array[][] = [];
  let currentPair: Uint8Array[] = [];

  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      minimumFragmentDuration: SINGLE_HLS_FRAGMENT_DURATION_SEC,
      onFtyp: (data: Uint8Array) => {
        initParts.push(new Uint8Array(data));
      },
      onMoov: (data: Uint8Array) => {
        initParts.push(new Uint8Array(data));
      },
      onMoof: (data: Uint8Array) => {
        const sequenceNumber =
          input.fragmentSequenceNumber === undefined
            ? undefined
            : input.fragmentSequenceNumber + moofMdatPairs.length;
        const moof = new Uint8Array(data);
        currentPair = [
          sequenceNumber === undefined ? moof : withFragmentSequenceNumber(moof, sequenceNumber),
        ];
        moofMdatPairs.push(currentPair);
      },
      onMdat: (data: Uint8Array) => {
        currentPair.push(new Uint8Array(data));
      },
    }),
    target: new NullTarget(),
  });

  const videoSource = new EncodedVideoPacketSource(input.videoCodec as VideoCodec);
  const hasAudioPackets = input.audioPackets.length > 0;
  if (hasAudioPackets && !input.audioDecoderConfig) {
    throw new Error(`Cannot mux audio codec ${input.audioCodec} without decoder config`);
  }
  const audioSource = hasAudioPackets
    ? new EncodedAudioPacketSource(input.audioCodec as AudioCodec)
    : null;

  output.addVideoTrack(videoSource);
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  // Feed video packets — pass decoder config on first packet
  const videoMeta: EncodedVideoChunkMetadata = {
    decoderConfig: input.videoDecoderConfig,
  };
  for (let i = 0; i < input.videoPackets.length; i++) {
    await videoSource.add(input.videoPackets[i], i === 0 ? videoMeta : undefined);
  }

  // Feed audio packets — pass decoder config on first packet
  if (audioSource && input.audioDecoderConfig) {
    const audioMeta: EncodedAudioChunkMetadata = { decoderConfig: input.audioDecoderConfig };
    for (let i = 0; i < input.audioPackets.length; i++) {
      await audioSource.add(input.audioPackets[i], i === 0 ? audioMeta : undefined);
    }
  }

  await output.finalize();

  const init = concatBuffers(initParts);
  const media = moofMdatPairs.map((pair) => concatBuffers(pair));
  const debugSummary = `${describeInitForDebug(init)} media=[${describeMediaForDebug(media)}]`;

  return { init, media, debugSummary };
}
