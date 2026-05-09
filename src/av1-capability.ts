/**
 * AV1 codec capability detection and mitigation for Safari/iOS.
 *
 * Safari/iPhone AV1 support is hardware-dependent and limited to newer Apple chips.
 * This module provides:
 * 1. WebCodecs API-based AV1 hardware capability detection
 * 2. WebM/AV1 metadata validation (Sequence Header presence)
 * 3. Fallback codec routing when AV1 is unsupported
 */

/**
 * Detects whether the browser/device supports AV1 decoding via WebCodecs API.
 * This is more reliable than MSE.isTypeSupported() for AV1 on Safari/iOS.
 *
 * Returns:
 * - 'supported': Hardware AV1 decoding is available
 * - 'unsupported': Device does not support AV1 (e.g., older iPhone/iPad)
 * - 'unknown': WebCodecs API unavailable or detection failed
 */
export async function detectAv1Support(): Promise<'supported' | 'unsupported' | 'unknown'> {
  // Check if WebCodecs API is available
  if (!('VideoDecoder' in globalThis)) {
    return 'unknown';
  }

  try {
    const config: VideoDecoderConfig = {
      codec: 'av01.0.01M.08', // AV1 Main profile, level 3.0
      codedWidth: 1920,
      codedHeight: 1080,
      hardwareAcceleration: 'prefer-hardware',
    };

    const support = await VideoDecoder.isConfigSupported(config);
    if (support.supported) {
      return 'supported';
    }

    // Try software fallback
    config.hardwareAcceleration = 'prefer-software';
    const softwareSupport = await VideoDecoder.isConfigSupported(config);
    return softwareSupport.supported ? 'supported' : 'unsupported';
  } catch (error) {
    console.warn('[AV1] WebCodecs detection failed:', error);
    return 'unknown';
  }
}

/**
 * Validates WebM/AV1 file metadata by checking for AV1 Sequence Header OBU.
 * This helps identify malformed AV1 files that may fail decode even on capable devices.
 *
 * Returns:
 * - true: Sequence Header found (file appears valid)
 * - false: Sequence Header not found (file may be malformed)
 * - null: Unable to validate (file too small or read error)
 */
export async function validateAv1Metadata(
  source: File | Blob | ArrayBuffer,
): Promise<boolean | null> {
  let buffer: ArrayBuffer;

  if (source instanceof ArrayBuffer) {
    buffer = source;
  } else {
    try {
      buffer = await source.slice(0, 65536).arrayBuffer(); // Read first 64KB
    } catch {
      return null;
    }
  }

  if (buffer.byteLength < 12) {
    return null; // Too small to contain WebM header
  }

  const view = new Uint8Array(buffer);

  // WebM EBML header signature: 0x1A 0x45 0xDF 0xA3
  if (view[0] !== 0x1a || view[1] !== 0x45 || view[2] !== 0xdf || view[3] !== 0xa3) {
    return null; // Not a WebM file
  }

  // Search for AV1 Sequence Header OBU (OBU type 1, frame type 0)
  // AV1 OBU structure: [obu_header][obu_size][obu_payload]
  // Sequence Header OBU type = 1 (bits 3-6 of first byte)
  for (let i = 4; i < Math.min(view.length - 1, 65536); i++) {
    const byte = view[i];
    const obuType = (byte >> 3) & 0x0f;

    // OBU type 1 = Sequence Header
    if (obuType === 1) {
      return true;
    }

    // Stop searching after first few OBUs to avoid scanning entire file
    if (obuType === 0 || obuType === 2) {
      // Frame or Tile Group OBU found before Sequence Header
      return false;
    }
  }

  return false; // Sequence Header not found in scanned region
}

/**
 * Determines fallback codec when AV1 is unavailable.
 * Prefers H.264 (broad compatibility) over VP9 (better quality but less support).
 */
export function getAv1Fallback(): 'avc' | 'vp9' {
  // H.264 has broader device support, especially on older iOS/Safari
  return 'avc';
}

/**
 * Generates user-facing warning message for AV1 unsupported devices.
 */
export function getAv1UnsupportedMessage(deviceInfo?: { isIos?: boolean; isOldDevice?: boolean }): string {
  if (deviceInfo?.isIos) {
    return 'This video uses AV1 codec which is not supported on your device. Playing H.264 version instead.';
  }
  return 'AV1 codec is not supported on your device. Playing alternative format instead.';
}

/**
 * Generates user-facing warning message for malformed AV1 files.
 */
export function getAv1MalformedMessage(): string {
  return 'This video file appears to be corrupted or incomplete. Attempting to play with fallback codec.';
}

/**
 * Detects device type for better error messaging.
 */
export function detectDeviceType(): {
  isIos: boolean;
  isOldDevice: boolean;
  userAgent: string;
} {
  const ua = navigator.userAgent.toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(ua);
  const isOldDevice = isIos && !/os (15|16|17|18)_/.test(ua); // iOS 15+ has better AV1 support

  return { isIos, isOldDevice, userAgent: ua };
}

/**
 * Caches AV1 support detection result to avoid repeated WebCodecs checks.
 */
let cachedAv1Support: 'supported' | 'unsupported' | 'unknown' | null = null;

export async function getCachedAv1Support(): Promise<'supported' | 'unsupported' | 'unknown'> {
  if (cachedAv1Support !== null) {
    return cachedAv1Support;
  }
  cachedAv1Support = await detectAv1Support();
  return cachedAv1Support;
}

export function clearAv1SupportCache(): void {
  cachedAv1Support = null;
}
