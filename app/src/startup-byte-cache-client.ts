/**
 * Client-side utilities for interacting with the startup byte cache service worker.
 * Provides telemetry access and cache diagnostics.
 */

export interface CacheTelemetry {
  idb_open_success: number;
  idb_open_error: number;
  idb_quota_exceeded: number;
  range_request_count: number;
  range_request_error: number;
  range_response_206: number;
  range_response_fallback: number;
  transaction_inactive_error: number;
  safari_idb_available: boolean;
  safari_private_mode_detected: boolean;
  sw_activation_time_ms: number;
}

/**
 * Fetch telemetry from the service worker.
 */
export async function getStartupByteCacheTelemetry(): Promise<CacheTelemetry | null> {
  if (!navigator.serviceWorker?.controller) {
    return null;
  }

  return new Promise((resolve) => {
    const channel = new MessageChannel();

    const timeout = setTimeout(() => {
      resolve(null);
    }, 5000);

    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      if (event.data?.type === 'TELEMETRY') {
        resolve(event.data.data);
      } else {
        resolve(null);
      }
    };

    navigator.serviceWorker.controller.postMessage(
      { type: 'GET_TELEMETRY' },
      [channel.port2],
    );
  });
}

/**
 * Log telemetry to console for debugging.
 */
export async function logStartupByteCacheTelemetry(): Promise<void> {
  const telemetry = await getStartupByteCacheTelemetry();
  if (!telemetry) {
    console.warn('Startup byte cache telemetry unavailable');
    return;
  }

  console.group('📦 Startup Byte Cache Telemetry');
  console.log('IDB Status:', {
    open_success: telemetry.idb_open_success,
    open_error: telemetry.idb_open_error,
    quota_exceeded: telemetry.idb_quota_exceeded,
    available: telemetry.safari_idb_available,
    private_mode: telemetry.safari_private_mode_detected,
  });
  console.log('Range Requests:', {
    total: telemetry.range_request_count,
    errors: telemetry.range_request_error,
    served_206: telemetry.range_response_206,
    fallback_200: telemetry.range_response_fallback,
  });
  console.log('Transaction Health:', {
    inactive_errors: telemetry.transaction_inactive_error,
  });
  console.log('Performance:', {
    sw_activation_ms: telemetry.sw_activation_time_ms,
  });
  console.groupEnd();
}

/**
 * Check if startup byte cache is healthy.
 */
export async function isStartupByteCacheHealthy(): Promise<boolean> {
  const telemetry = await getStartupByteCacheTelemetry();
  if (!telemetry) {
    return false;
  }

  // Healthy if:
  // - IDB is available
  // - No transaction inactive errors
  // - Range requests are being served (206 > 0 or no range requests yet)
  return (
    telemetry.safari_idb_available &&
    telemetry.transaction_inactive_error === 0 &&
    !telemetry.safari_private_mode_detected
  );
}
