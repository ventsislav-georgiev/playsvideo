/**
 * InnerTube integration layer: converts extracted manifests to playback options.
 * Bridges InnerTube streaming data → PlaybackOption selection.
 */

import type { PlaybackOption, PlaybackMediaMetadata } from './playback-selection.js';
import type { ExtractedManifest, ExtractedAdaptiveFormat } from './innertube-manifest.js';

export interface InnerTubePlaybackInput {
  manifest: ExtractedManifest;
  contentId?: string;
}

export interface InnerTubePlaybackResult {
  options: PlaybackOption[];
  metadata: PlaybackMediaMetadata;
}

/**
 * Convert extracted InnerTube manifest to playback options and metadata.
 * Prioritizes HLS if available, falls back to direct URLs.
 */
export function convertInnerTubeToPlaybackOptions(
  input: InnerTubePlaybackInput,
): InnerTubePlaybackResult {
  const { manifest, contentId } = input;
  const options: PlaybackOption[] = [];
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let hasAudioTrack = false;

  // Extract codec info from adaptive formats
  const videoFormats = manifest.adaptiveFormats.filter((fmt) =>
    fmt.mimeType.startsWith('video/'),
  );
  const audioFormats = manifest.adaptiveFormats.filter((fmt) =>
    fmt.mimeType.startsWith('audio/'),
  );

  if (videoFormats.length > 0) {
    videoCodec = extractCodecFromMimeType(videoFormats[0].mimeType);
  }

  if (audioFormats.length > 0) {
    audioCodec = extractCodecFromMimeType(audioFormats[0].mimeType);
    hasAudioTrack = true;
  }

  // HLS option (preferred if available)
  if (manifest.hlsUrl) {
    options.push({
      mode: 'hls',
      id: contentId ? `innertube-hls-${contentId}` : 'innertube-hls',
    });
  }

  // DASH option (if available)
  if (manifest.dashUrl) {
    options.push({
      mode: 'direct-url',
      id: contentId ? `innertube-dash-${contentId}` : 'innertube-dash',
      url: manifest.dashUrl,
      mimeType: 'application/dash+xml',
    });
  }

  // Direct format URLs (fallback)
  for (const fmt of manifest.formats) {
    if (fmt.url) {
      options.push({
        mode: 'direct-url',
        id: contentId ? `innertube-fmt-${fmt.itag}-${contentId}` : `innertube-fmt-${fmt.itag}`,
        url: fmt.url,
        mimeType: fmt.mimeType,
      });
    }
  }

  // If no options generated, provide a fallback HLS mode
  if (options.length === 0) {
    options.push({ mode: 'hls' });
  }

  const metadata: PlaybackMediaMetadata = {
    sourceVideoCodec: videoCodec,
    sourceAudioCodec: audioCodec,
    videoCodec,
    audioCodec,
    hasAudioTrack,
    isAv1Video: videoCodec === 'av01',
  };

  return { options, metadata };
}

/**
 * Extract short codec name from MIME type.
 * E.g., 'video/mp4; codecs="avc1.640028"' → 'avc1'
 */
function extractCodecFromMimeType(mimeType: string): string | null {
  const codecMatch = mimeType.match(/codecs="([^"]+)"/);
  if (!codecMatch) return null;

  const fullCodec = codecMatch[1];
  // Extract short codec (first part before dot or comma)
  const shortCodec = fullCodec.split(/[.,]/)[0];
  return shortCodec || null;
}

/**
 * Determine if HLS manifest URL should be used directly or if DASH/direct URLs are preferred.
 * Returns the recommended manifest URL for hls.loadSource().
 */
export function selectHlsManifestUrl(manifest: ExtractedManifest): string | null {
  // Prefer HLS manifest if available
  if (manifest.hlsUrl) {
    return manifest.hlsUrl;
  }

  // Fallback: if only DASH available, return null (DASH requires different handling)
  if (manifest.dashUrl) {
    return null;
  }

  return null;
}
