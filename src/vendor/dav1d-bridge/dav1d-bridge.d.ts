export interface Dav1dBridgeFrame {
  width: number;
  height: number;
  data: Uint8Array;
  bitDepth: number;
  layout: number;
  status: number;
  timestamp: number;
  downconverted: true;
}

export interface Dav1dBridgeDecoder {
  sendPacket(data: Uint8Array | ArrayBuffer, timestamp?: number | bigint): void;
  receiveFrame(): Dav1dBridgeFrame;
  decodeFrameAsYUV(obu: Uint8Array | ArrayBuffer): Dav1dBridgeFrame;
  flush(): void;
  unsafeCleanup(): void;
}

export function createDav1dBridge(opts: {
  wasmURL?: string;
  wasmData?: ArrayBuffer | Uint8Array;
}): Promise<Dav1dBridgeDecoder>;
