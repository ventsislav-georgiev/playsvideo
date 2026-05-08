import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbortableUrlSource } from '../../src/pipeline/demux.js';

function installRangeFetchMock(data: Uint8Array, options?: { supportsRange?: boolean }): string[] {
  const requests: string[] = [];
  const supportsRange = options?.supportsRange !== false;

  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') {
      requests.push('HEAD');
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': String(data.byteLength),
          'content-type': 'video/mp4',
          'accept-ranges': 'bytes',
        },
      });
    }

    const range = new Headers(init?.headers).get('range');
    requests.push(range ?? 'none');

    // Non-offline size detection request: Range: bytes=0-
    if (range === 'bytes=0-') {
      if (supportsRange) {
        // Server supports ranges: return 206 with Content-Range
        return new Response(data.slice(0, Math.min(65536, data.byteLength)), {
          status: 206,
          headers: {
            'content-length': String(Math.min(65536, data.byteLength)),
            'content-range': `bytes 0-${Math.min(65535, data.byteLength - 1)}/${data.byteLength}`,
          },
        });
      } else {
        // Server doesn't support ranges: return 200 with Content-Length
        return new Response(data, {
          status: 200,
          headers: {
            'content-length': String(data.byteLength),
          },
        });
      }
    }

    // Regular range request
    const match = range?.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) throw new Error(`Unexpected range: ${range}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(data.slice(start, end + 1), {
      status: 206,
      headers: {
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${data.byteLength}`,
      },
    });
  }) as typeof fetch;

  return requests;
}

describe('AbortableUrlSource', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('detects file size using Range: bytes=0- with 206 response', async () => {
    const data = new Uint8Array(1024 * 1024);
    const requests = installRangeFetchMock(data, { supportsRange: true });

    const source = new AbortableUrlSource('https://example.test/video.mkv');
    const size = await source._retrieveSize();

    expect(size).toBe(1024 * 1024);
    expect(requests[0]).toBe('bytes=0-');
  });

  it('detects file size using Content-Length with 200 response', async () => {
    const data = new Uint8Array(1024 * 1024);
    const requests = installRangeFetchMock(data, { supportsRange: false });

    const source = new AbortableUrlSource('https://example.test/video.mkv');
    const size = await source._retrieveSize();

    expect(size).toBe(1024 * 1024);
    expect(requests[0]).toBe('bytes=0-');
  });

  it('caches initial chunk from size detection for reuse', async () => {
    const data = new Uint8Array(1024 * 1024);
    data.forEach((_, index) => {
      data[index] = index % 251;
    });
    const requests = installRangeFetchMock(data, { supportsRange: true });

    const source = new AbortableUrlSource('https://example.test/video.mkv');
    await source._retrieveSize();

    // Read from the cached initial chunk (0-65536)
    const cached = await source._read(1000, 2000);
    expect(Array.from(cached.bytes)).toEqual(Array.from(data.slice(1000, 2000)));

    // Should only have the size detection request, not a separate read request
    expect(requests).toEqual(['bytes=0-']);
  });

  it('fetches chunk-aligned read-ahead windows for offline video URLs and serves later reads from cache', async () => {
    const data = new Uint8Array(2 * 1024 * 1024);
    data.forEach((_, index) => {
      data[index] = index % 251;
    });
    const requests = installRangeFetchMock(data, { supportsRange: true });

    const source = new AbortableUrlSource('/offline-video/title-1');
    await source._retrieveSize();

    const first = await source._read(10_000, 10_064);
    const second = await source._read(250_000, 250_128);
    const third = await source._read(530_000, 530_064);

    expect(Array.from(first.bytes)).toEqual(Array.from(data.slice(10_000, 10_064)));
    expect(Array.from(second.bytes)).toEqual(Array.from(data.slice(250_000, 250_128)));
    expect(Array.from(third.bytes)).toEqual(Array.from(data.slice(530_000, 530_064)));
    // Offline size detection uses HEAD to avoid materializing a body through iOS Safari's service worker.
    // Reads use bounded read-ahead so sparse MP4 metadata probes do not materialize oversized ranges.
    expect(requests).toEqual(['HEAD', 'bytes=0-524287', 'bytes=524288-1048575']);
  });

  it('fetches only the missing suffix for overlapping offline reads', async () => {
    const data = new Uint8Array(2 * 1024 * 1024);
    data.forEach((_, index) => {
      data[index] = index % 251;
    });
    const requests = installRangeFetchMock(data, { supportsRange: true });

    const source = new AbortableUrlSource('/offline-video/title-1');
    await source._retrieveSize();

    const tinyProbe = await source._read(0, 12);
    const metadataProbe = await source._read(40, 600_000);

    expect(Array.from(tinyProbe.bytes)).toEqual(Array.from(data.slice(0, 12)));
    expect(Array.from(metadataProbe.bytes)).toEqual(Array.from(data.slice(40, 600_000)));
    expect(requests).toEqual(['HEAD', 'bytes=0-524287', 'bytes=524288-1048575']);
  });

  it('keeps exact byte ranges for non-offline URLs', async () => {
    const data = new Uint8Array(1024 * 1024);
    const requests = installRangeFetchMock(data, { supportsRange: true });

    const source = new AbortableUrlSource('https://example.test/video.mkv');
    await source._retrieveSize();

    await source._read(10_000, 10_064);
    await source._read(250_000, 250_128);

    // Size detection + one exact range request
    // First read (10_000-10_064) is served from cached initial chunk (0-65536)
    // Second read (250_000-250_128) requires a separate request
    expect(requests).toEqual(['bytes=0-', 'bytes=250000-250127']);
  });
});
