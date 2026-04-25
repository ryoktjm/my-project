import * as THREE from 'three';

export interface MeshData {
  /** Float32Array of vertex positions (x,y,z triplets) */
  position: Float32Array;
  /** Float32Array of per-vertex normals — omit to auto-compute */
  normal?: Float32Array;
  /** Uint32Array face indices — omit for non-indexed geometry */
  index?: Uint32Array;
  /** RGB colour in [0,1] range from the STEP file, or null for default */
  color: [number, number, number] | null;
}

// Keys present on MeshPhongMaterial that may hold a Texture.
// roughnessMap / metalnessMap belong to MeshStandardMaterial — excluded here.
const TEXTURE_KEYS = [
  'map', 'specularMap', 'normalMap', 'bumpMap',
  'alphaMap', 'aoMap', 'emissiveMap', 'envMap', 'lightMap', 'displacementMap',
] as const satisfies ReadonlyArray<keyof THREE.MeshPhongMaterial>;

/**
 * Wraps a THREE.Group representing one loaded file.
 *
 * Translation is stored as a Matrix4 (matrixAutoUpdate = false).
 * All delta values are standard JS Number (64-bit float), which gives
 * sub-micrometre precision well beyond the 0.0001 mm requirement.
 */
export class ModelObject {
  readonly name: string;
  readonly group: THREE.Group;

  constructor(name: string) {
    this.name = name;
    this.group = new THREE.Group();
    this.group.name = name;
    this.group.matrixAutoUpdate = false;
    // matrix starts as identity — no translation applied
  }

  addMesh(data: MeshData): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(data.position, 3));
    if (data.normal) {
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(data.normal, 3));
    } else {
      geo.computeVertexNormals();
    }
    if (data.index) {
      geo.setIndex(new THREE.BufferAttribute(data.index, 1));
    }

    const material = new THREE.MeshPhongMaterial({
      color: data.color ? new THREE.Color(...data.color) : 0x4a90d9,
      specular: 0x222222,
      shininess: 40,
      side: THREE.DoubleSide,
    });

    this.group.add(new THREE.Mesh(geo, material));
  }

  /**
   * Accumulate a relative translation (ΔX, ΔY, ΔZ) in Z-up user coordinates (mm).
   * Uses matrix.multiply so prior translations are preserved exactly —
   * no floating-point loss from position.add() accumulation.
   */
  applyRelativeTranslation(dx: number, dy: number, dz: number): void {
    const delta = new THREE.Matrix4().makeTranslation(dx, dy, dz);
    this.group.matrix.multiply(delta);
    this.group.matrixWorldNeedsUpdate = true;
  }

  /**
   * Return cloned geometries with the current translation matrix baked in.
   * Used at STL export time — live geometry is never mutated.
   * Output is in Z-up user coordinates (zUpRoot rotation is intentionally excluded).
   */
  getBakedGeometries(): THREE.BufferGeometry[] {
    const result: THREE.BufferGeometry[] = [];
    this.group.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const geo = mesh.geometry.clone();
      const exportMatrix = new THREE.Matrix4().multiplyMatrices(
        this.group.matrix,
        mesh.matrix,
      );
      geo.applyMatrix4(exportMatrix);
      result.push(geo);
    });
    return result;
  }

  /** Release all WebGL resources (geometry buffers + all material textures). */
  dispose(): void {
    this.group.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.MeshPhongMaterial;
      for (const key of TEXTURE_KEYS) {
        const tex = mat[key] as THREE.Texture | null | undefined;
        if (tex?.isTexture) tex.dispose();
      }
      mat.dispose();
    });
  }
}
