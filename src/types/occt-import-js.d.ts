/**
 * Minimal type declarations for occt-import-js.
 * The library ships no .d.ts; these cover only the API surface we use.
 */
declare module 'occt-import-js' {
  interface OcctAttribute {
    /** View into WASM heap — copy before releasing result. */
    array: Float32Array;
  }

  interface OcctMesh {
    attributes: {
      position: OcctAttribute;
      normal?: OcctAttribute;
    };
    index?: { array: ArrayLike<number> };
    /** Per-mesh RGB colour from the STEP file, or null for default. */
    color: [number, number, number] | null;
  }

  interface OcctResult {
    success: boolean;
    meshes: OcctMesh[];
  }

  interface OcctInstance {
    ReadStepFile(data: Uint8Array, params: null): OcctResult;
  }

  type OcctInitFn = (opts?: { locateFile?: (filename: string) => string }) => Promise<OcctInstance>;

  export type { OcctInstance, OcctResult, OcctMesh, OcctAttribute };
  export default occtimportjs;
  const occtimportjs: OcctInitFn;
}
