declare module 'dav1d.js' {
  export interface Dav1dFrame {
    width: number;
    height: number;
    data: Uint8Array;
    bitDepth?: number;
    layout?: number;
    timestamp?: number;
    downconverted?: boolean;
  }

  export interface Dav1dDecoder {
    sendPacket?(obu: Uint8Array | ArrayBuffer, timestamp?: number | bigint): void;
    receiveFrame?(): Dav1dFrame;
    decodeFrameAsYUV(obu: Uint8Array | ArrayBuffer): Dav1dFrame;
    decodeFrameAsBMP(obu: Uint8Array | ArrayBuffer): Dav1dFrame;
    unsafeDecodeFrameAsYUV(obu: Uint8Array | ArrayBuffer): Uint8Array;
    unsafeDecodeFrameAsBMP(obu: Uint8Array | ArrayBuffer): Uint8Array;
    unsafeCleanup(): void;
  }

  export function create(opts: { wasmURL?: string; wasmData?: ArrayBuffer | Uint8Array }): Promise<Dav1dDecoder>;

  const defaultExport: { create: typeof create };
  export default defaultExport;
}
