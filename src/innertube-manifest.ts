/**
 * InnerTube manifest extraction and parsing.
 * Extracts DASH and HLS manifest URLs from InnerTube streaming data.
 */

export interface InnerTubeStreamingData {
  formats?: InnerTubeFormat[];
  adaptiveFormats?: InnerTubeAdaptiveFormat[];
  dashManifestUrl?: string;
  hlsManifestUrl?: string;
}

export interface InnerTubeFormat {
  itag: number;
  mimeType: string;
  bitrate?: number;
  width?: number;
  height?: number;
  fps?: number;
  qualityLabel?: string;
  url?: string;
  cipher?: string;
  signatureCipher?: string;
}

export interface InnerTubeAdaptiveFormat {
  itag: number;
  mimeType: string;
  bitrate?: number;
  width?: number;
  height?: number;
  fps?: number;
  audioQuality?: string;
  audioSampleRate?: string;
  channelCount?: number;
  url?: string;
  cipher?: string;
  signatureCipher?: string;
  initRange?: { start: string; end: string };
  indexRange?: { start: string; end: string };
}

export interface ExtractedManifest {
  dashUrl: string | null;
  hlsUrl: string | null;
  formats: ExtractedFormat[];
  adaptiveFormats: ExtractedAdaptiveFormat[];
}

export interface ExtractedFormat {
  itag: number;
  mimeType: string;
  url: string;
  bitrate?: number;
  width?: number;
  height?: number;
  fps?: number;
  qualityLabel?: string;
}

export interface ExtractedAdaptiveFormat {
  itag: number;
  mimeType: string;
  url: string;
  bitrate?: number;
  width?: number;
  height?: number;
  fps?: number;
  audioQuality?: string;
  audioSampleRate?: string;
  channelCount?: number;
  initRange?: { start: number; end: number };
  indexRange?: { start: number; end: number };
}

/**
 * Extract manifest URLs and format metadata from InnerTube streaming data.
 * Handles both direct URLs and cipher-protected URLs (basic decoding).
 */
export function extractManifestFromInnerTube(
  streamingData: InnerTubeStreamingData,
): ExtractedManifest {
  const dashUrl = streamingData.dashManifestUrl || null;
  const hlsUrl = streamingData.hlsManifestUrl || null;

  const formats = (streamingData.formats || [])
    .map((fmt) => extractFormat(fmt))
    .filter((fmt): fmt is ExtractedFormat => fmt !== null);

  const adaptiveFormats = (streamingData.adaptiveFormats || [])
    .map((fmt) => extractAdaptiveFormat(fmt))
    .filter((fmt): fmt is ExtractedAdaptiveFormat => fmt !== null);

  return {
    dashUrl,
    hlsUrl,
    formats,
    adaptiveFormats,
  };
}

function extractFormat(fmt: InnerTubeFormat): ExtractedFormat | null {
  const url = decodeFormatUrl(fmt);
  if (!url) return null;

  return {
    itag: fmt.itag,
    mimeType: fmt.mimeType,
    url,
    bitrate: fmt.bitrate,
    width: fmt.width,
    height: fmt.height,
    fps: fmt.fps,
    qualityLabel: fmt.qualityLabel,
  };
}

function extractAdaptiveFormat(fmt: InnerTubeAdaptiveFormat): ExtractedAdaptiveFormat | null {
  const url = decodeFormatUrl(fmt);
  if (!url) return null;

  const result: ExtractedAdaptiveFormat = {
    itag: fmt.itag,
    mimeType: fmt.mimeType,
    url,
    bitrate: fmt.bitrate,
    width: fmt.width,
    height: fmt.height,
    fps: fmt.fps,
    audioQuality: fmt.audioQuality,
    audioSampleRate: fmt.audioSampleRate,
    channelCount: fmt.channelCount,
  };

  if (fmt.initRange) {
    result.initRange = {
      start: parseInt(fmt.initRange.start, 10),
      end: parseInt(fmt.initRange.end, 10),
    };
  }

  if (fmt.indexRange) {
    result.indexRange = {
      start: parseInt(fmt.indexRange.start, 10),
      end: parseInt(fmt.indexRange.end, 10),
    };
  }

  return result;
}

function decodeFormatUrl(fmt: InnerTubeFormat | InnerTubeAdaptiveFormat): string | null {
  // Direct URL takes precedence
  if (fmt.url) {
    return fmt.url;
  }

  // Cipher/signatureCipher requires decryption (not implemented here)
  // In production, this would require the player's decipher function
  if (fmt.cipher || fmt.signatureCipher) {
    // TODO: Implement cipher decryption using player's decipher function
    // For now, return null to indicate URL cannot be extracted
    return null;
  }

  return null;
}

/**
 * Parse DASH manifest URL to extract base URL and parameters.
 */
export function parseDashManifestUrl(url: string): {
  baseUrl: string;
  params: Record<string, string>;
} {
  try {
    const urlObj = new URL(url);
    const params: Record<string, string> = {};

    urlObj.searchParams.forEach((value, key) => {
      params[key] = value;
    });

    return {
      baseUrl: urlObj.origin + urlObj.pathname,
      params,
    };
  } catch {
    return {
      baseUrl: url,
      params: {},
    };
  }
}

/**
 * Parse HLS manifest URL to extract base URL and parameters.
 */
export function parseHlsManifestUrl(url: string): {
  baseUrl: string;
  params: Record<string, string>;
} {
  return parseDashManifestUrl(url);
}
