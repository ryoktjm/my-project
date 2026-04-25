/// <reference types="vite/client" />
/**
 * loader.worker.ts
 *
 * Web Worker that parses STEP/STL files off the main thread.
 * Returns mesh data as Transferable ArrayBuffers to avoid copying.
 *
 * WASM memory safety: occt-import-js attributes are views into the WASM heap.
 * We copy them into plain Float32Array / Uint32Array before transferring so
 * the WASM heap is free to be reused after ReadStepFile() returns.
 *
 * WASM asset handling: the WASM binary is imported with Vite's `?url` suffix
 * so Vite manages the asset lifecycle in both dev and production:
 *   dev  → served from the Vite dev server
 *   prod → copied to dist/renderer/assets/ with content hash, URL is relative
 */

// Vite resolves this import and copies the WASM to the output directory.
// `assetsInclude: ['**/*.wasm']` in electron.vite.config.ts ensures .wasm
// files from node_modules are treated as static assets.
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

// ─── Message types ────────────────────────────────────────────────────────────

export interface LoadRequest {
  type: 'stl' | 'step';
  buffer: ArrayBuffer;
  fileName: string;
}

export interface MeshTransfer {
  position: ArrayBuffer; // Float32Array backing buffer
  normal?: ArrayBuffer;  // Float32Array backing buffer
  index?: ArrayBuffer;   // Uint32Array backing buffer
  color: [number, number, number] | null;
}

export interface WorkerSuccessResponse {
  type: 'success';
  fileName: string;
  meshes: MeshTransfer[];
}

export interface WorkerErrorResponse {
  type: 'error';
  fileName: string;
  error: string;
}

export type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;

// ─── Binary STL parser ────────────────────────────────────────────────────────
// Avoids importing Three.js into the worker. Handles binary STL only;
// ASCII STL is rare in CAD workflows and can be pre-converted.

function parseSTLBinary(buffer: ArrayBuffer): MeshTransfer {
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);

  const positions = new Float32Array(triCount * 9); // 3 verts × 3 coords
  const normals   = new Float32Array(triCount * 9);

  let off = 84;
  for (let i = 0; i < triCount; i++) {
    const nx = view.getFloat32(off,      true);
    const ny = view.getFloat32(off +  4, true);
    const nz = view.getFloat32(off +  8, true);
    off += 12;

    for (let v = 0; v < 3; v++) {
      const base = i * 9 + v * 3;
      positions[base]     = view.getFloat32(off,     true);
      positions[base + 1] = view.getFloat32(off + 4, true);
      positions[base + 2] = view.getFloat32(off + 8, true);
      normals[base]     = nx;
      normals[base + 1] = ny;
      normals[base + 2] = nz;
      off += 12;
    }
    off += 2; // attribute byte count
  }

  return { position: positions.buffer, normal: normals.buffer, color: null };
}

function isAsciiSTL(buffer: ArrayBuffer): boolean {
  const header = new Uint8Array(buffer, 0, Math.min(256, buffer.byteLength));
  const text = String.fromCharCode(...header);
  return text.trimStart().startsWith('solid');
}

// ─── OCCT singleton ───────────────────────────────────────────────────────────

import type { OcctInstance } from 'occt-import-js';
let occtInstance: OcctInstance | null = null; // eslint-disable-line

async function getOcct(): Promise<OcctInstance> {
  if (occtInstance) return occtInstance;
  const { default: init } = await import('occt-import-js');
  occtInstance = await init({
    // occtWasmUrl is resolved by Vite at build time:
    //   dev  → URL served by Vite dev server
    //   prod → relative URL to the hashed asset in dist/renderer/assets/
    // This avoids the fragile import.meta.url relative-path pattern which
    // breaks in production when the worker bundle moves to dist/renderer/assets/.
    locateFile: (f: string) => (f === 'occt-import-js.wasm' ? occtWasmUrl : f),
  });
  return occtInstance;
}

// ─── STEP parser ──────────────────────────────────────────────────────────────

async function parseSTEP(buffer: ArrayBuffer): Promise<MeshTransfer[]> {
  const occt   = await getOcct();
  const result = occt.ReadStepFile(new Uint8Array(buffer), null);
  if (!result.success) throw new Error('STEP file parse failed');

  return result.meshes.map((m) => {
    // Copy out of WASM heap before `result` goes out of scope
    const position = new Float32Array(m.attributes.position.array).buffer;
    const normal   = m.attributes.normal
      ? new Float32Array(m.attributes.normal.array).buffer
      : undefined;
    const index    = m.index
      ? Uint32Array.from(m.index.array).buffer
      : undefined;
    return { position, normal, index, color: m.color };
  });
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<LoadRequest>) => {
  const { type, buffer, fileName } = event.data;

  try {
    let meshes: MeshTransfer[];

    if (type === 'stl') {
      if (isAsciiSTL(buffer)) {
        throw new Error('ASCII STL is not supported. Please save as Binary STL.');
      }
      meshes = [parseSTLBinary(buffer)];
    } else {
      meshes = await parseSTEP(buffer);
    }

    // Transfer ownership of all ArrayBuffers — zero-copy pass to main thread
    const transferables: ArrayBuffer[] = meshes.flatMap((m) => [
      m.position,
      ...(m.normal ? [m.normal] : []),
      ...(m.index  ? [m.index]  : []),
    ]);

    const response: WorkerSuccessResponse = { type: 'success', fileName, meshes };
    (self as unknown as Worker).postMessage(response, transferables);

  } catch (err) {
    const response: WorkerErrorResponse = {
      type: 'error',
      fileName,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(response, []);
  }
};
