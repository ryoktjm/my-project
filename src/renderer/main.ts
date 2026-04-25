/// <reference types="vite/client" />

import './styles.css';
import * as THREE from 'three';
import { SceneManager }  from './core/SceneManager';
import { ModelObject }   from './core/ModelObject';
import type { WorkerResponse } from './workers/loader.worker';

// ─── Electron API (injected by preload) ──────────────────────────────────────

declare global {
  interface Window {
    electronAPI: {
      openFileDialog: () => Promise<void>;
      saveStlDialog:  (data: ArrayBuffer) => Promise<{ success: boolean }>;
      onLoadModel:    (cb: (data: { fileName: string; buffer: ArrayBuffer }) => void) => void;
    };
  }
}

// ─── App state ────────────────────────────────────────────────────────────────

const container   = document.getElementById('canvas-container') as HTMLElement;
const sceneManager = new SceneManager(container);

/** Lookup ModelObject by its THREE.Group (WeakMap — group is GC-friendly). */
const modelMap    = new WeakMap<THREE.Group, ModelObject>();
let selectedModel: ModelObject | null = null;

// ─── Worker ──────────────────────────────────────────────────────────────────

const loaderWorker = new Worker(
  new URL('./workers/loader.worker.ts', import.meta.url),
  { type: 'module' },
);

loaderWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  showLoading(false);
  const msg = event.data;

  if (msg.type === 'error') {
    alert(`読み込みエラー: ${msg.error}`);
    return;
  }

  const model = new ModelObject(msg.fileName);
  for (const m of msg.meshes) {
    model.addMesh({
      // Wrap transferred buffers back into typed arrays
      position: new Float32Array(m.position),
      normal:   m.normal ? new Float32Array(m.normal) : undefined,
      index:    m.index  ? new Uint32Array(m.index)   : undefined,
      color:    m.color,
    });
  }

  const isFirst = sceneManager.modelsContainer.children.length === 0;
  sceneManager.modelsContainer.add(model.group);
  modelMap.set(model.group, model);
  if (isFirst) sceneManager.fitCamera();
};

// ─── UI element refs ─────────────────────────────────────────────────────────

const btnDelete   = document.getElementById('btn-delete')   as HTMLButtonElement;
const btnMove     = document.getElementById('btn-move')     as HTMLButtonElement;
const btnReset    = document.getElementById('btn-reset')    as HTMLButtonElement;
const btnOpen     = document.getElementById('btn-open')     as HTMLButtonElement;
const btnExport   = document.getElementById('btn-export')   as HTMLButtonElement;
const selLabel    = document.getElementById('selection-label') as HTMLSpanElement;
const moveDialog  = document.getElementById('move-dialog')  as HTMLElement;
const loadingEl   = document.getElementById('loading-overlay') as HTMLElement;
const dropOverlay = document.getElementById('drop-overlay') as HTMLElement;
const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
const moveX       = document.getElementById('move-x')  as HTMLInputElement;
const moveY       = document.getElementById('move-y')  as HTMLInputElement;
const moveZ       = document.getElementById('move-z')  as HTMLInputElement;

function showLoading(v: boolean): void {
  loadingEl.classList.toggle('visible', v);
}

// ─── Selection ────────────────────────────────────────────────────────────────

function selectModel(model: ModelObject | null): void {
  selectedModel?.setHighlight(false);
  selectedModel = model;
  const has = model !== null;
  btnDelete.disabled = !has;
  btnMove.disabled   = !has;
  selLabel.textContent = has ? `選択中: ${model!.name}` : '';
  if (has) model!.setHighlight(true);
}

sceneManager.onClick = (e: MouseEvent) => {
  const rect = sceneManager.canvas.getBoundingClientRect();
  const inside =
    e.clientX >= rect.left && e.clientX <= rect.right &&
    e.clientY >= rect.top  && e.clientY <= rect.bottom;
  if (!inside) return;
  const group = sceneManager.pickGroup(e);
  selectModel(group ? (modelMap.get(group) ?? null) : null);
};

// ─── Deletion ─────────────────────────────────────────────────────────────────

function deleteSelected(): void {
  if (!selectedModel) return;
  sceneManager.modelsContainer.remove(selectedModel.group);
  selectedModel.dispose();
  selectModel(null);
}

btnDelete.addEventListener('click', deleteSelected);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' && selectedModel && document.activeElement?.tagName !== 'INPUT') {
    deleteSelected();
  }
});

// ─── File loading ─────────────────────────────────────────────────────────────

function loadFile(buffer: ArrayBuffer, fileName: string): void {
  const ext  = fileName.split('.').pop()?.toLowerCase() ?? '';
  const type = ext === 'stl' ? 'stl' : 'step';
  showLoading(true);
  loaderWorker.postMessage({ type, buffer, fileName }, [buffer]);
}

btnOpen.addEventListener('click', () => window.electronAPI.openFileDialog());
window.electronAPI.onLoadModel(({ fileName, buffer }) => loadFile(buffer, fileName));

container.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropOverlay.classList.add('visible');
});
container.addEventListener('dragleave', () => dropOverlay.classList.remove('visible'));
container.addEventListener('drop', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('visible');
  for (const file of Array.from(e.dataTransfer?.files ?? [])) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['step', 'stp', 'stl'].includes(ext)) continue;
    file.arrayBuffer().then((buf) => loadFile(buf, file.name));
  }
});

// ─── Reset ────────────────────────────────────────────────────────────────────

btnReset.addEventListener('click', () => sceneManager.fitCamera());

// ─── Move dialog ─────────────────────────────────────────────────────────────

btnMove.addEventListener('click', () => {
  moveX.value = '0'; moveY.value = '0'; moveZ.value = '0';
  moveDialog.classList.add('visible');
  moveX.focus();
});

document.getElementById('move-cancel')!.addEventListener('click', () => {
  moveDialog.classList.remove('visible');
});

document.getElementById('move-ok')!.addEventListener('click', () => {
  if (!selectedModel) { moveDialog.classList.remove('visible'); return; }
  // JS Number = 64-bit float → maintains 0.0001 mm precision without special handling
  const dx = parseFloat(moveX.value) || 0;
  const dy = parseFloat(moveY.value) || 0;
  const dz = parseFloat(moveZ.value) || 0;
  selectedModel.applyRelativeTranslation(dx, dy, dz);
  moveDialog.classList.remove('visible');
});

// ─── Export STL ──────────────────────────────────────────────────────────────

btnExport.addEventListener('click', async () => {
  if (sceneManager.modelsContainer.children.length === 0) {
    alert('エクスポートするモデルがありません。');
    return;
  }
  await window.electronAPI.saveStlDialog(buildSTLBuffer());
});

/**
 * Binary STL builder.
 * Calls ModelObject.getBakedGeometries() which applies the translation matrix
 * to vertex data at export time only — live geometry is never mutated.
 * Output is in Z-up user coordinates (zUpRoot rotation intentionally excluded).
 */
function buildSTLBuffer(): ArrayBuffer {
  // Collect all ModelObjects from direct children of modelsContainer
  const models: ModelObject[] = [];
  for (const child of sceneManager.modelsContainer.children) {
    const m = modelMap.get(child as THREE.Group);
    if (m) models.push(m);
  }

  const allGeo = models.flatMap((m) => m.getBakedGeometries());

  let totalTri = 0;
  for (const geo of allGeo) {
    totalTri += geo.index
      ? geo.index.count / 3
      : geo.attributes.position.count / 3;
  }

  const buf  = new ArrayBuffer(84 + totalTri * 50);
  const view = new DataView(buf);
  let off = 80;
  view.setUint32(off, totalTri, true); off += 4;

  for (const geo of allGeo) {
    const posAttr = geo.attributes.position as THREE.BufferAttribute;
    const idx     = geo.index ? geo.index.array : null;
    const triCount = idx ? idx.length / 3 : posAttr.count / 3;

    for (let i = 0; i < triCount; i++) {
      const ia = idx ? idx[i*3]   : i*3;
      const ib = idx ? idx[i*3+1] : i*3+1;
      const ic = idx ? idx[i*3+2] : i*3+2;

      const ax = posAttr.getX(ia), ay = posAttr.getY(ia), az = posAttr.getZ(ia);
      const bx = posAttr.getX(ib), by = posAttr.getY(ib), bz = posAttr.getZ(ib);
      const cx = posAttr.getX(ic), cy = posAttr.getY(ic), cz = posAttr.getZ(ic);

      const e1x = bx-ax, e1y = by-ay, e1z = bz-az;
      const e2x = cx-ax, e2y = cy-ay, e2z = cz-az;

      let nx = e1y*e2z - e1z*e2y;
      let ny = e1z*e2x - e1x*e2z;
      let nz = e1x*e2y - e1y*e2x;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;

      for (const [x, y, z] of [
        [nx, ny, nz],
        [ax, ay, az], [bx, by, bz], [cx, cy, cz],
      ] as [number, number, number][]) {
        view.setFloat32(off, x, true); off += 4;
        view.setFloat32(off, y, true); off += 4;
        view.setFloat32(off, z, true); off += 4;
      }
      view.setUint16(off, 0, true); off += 2;
    }

    // Release the temporary baked geometry
    geo.dispose();
  }

  return buf;
}

// ─── Theme ────────────────────────────────────────────────────────────────────

themeSelect.addEventListener('change', () => {
  sceneManager.applyTheme(
    themeSelect.value as Parameters<typeof sceneManager.applyTheme>[0],
  );
});

// Restore persisted theme on startup (default: dark)
sceneManager.applyTheme(
  (localStorage.getItem('theme') as Parameters<typeof sceneManager.applyTheme>[0]) ?? 'dark',
);
