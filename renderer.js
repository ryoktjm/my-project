import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

// ─── Renderer ─────────────────────────────────────────────────────────────────
const container = document.getElementById('canvas-container');

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

// near=0.001mm / far=10,000,000mm for 0.0001mm precision with logarithmicDepthBuffer
const camera = new THREE.PerspectiveCamera(
  45, container.clientWidth / container.clientHeight, 0.001, 1e7
);
const INITIAL_CAM_POS = new THREE.Vector3(0, 200, 500);
camera.position.copy(INITIAL_CAM_POS);
camera.lookAt(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight1.position.set(500, 800, 500);
scene.add(dirLight1);
const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
dirLight2.position.set(-500, -200, -500);
scene.add(dirLight2);

// ─── Z-up root ────────────────────────────────────────────────────────────────
// All scene content is authored in right-hand Z-up (X=右, Y=奥行き, Z=上).
// rotation.x = -π/2 maps Z-up (x,y,z) → Three.js Y-up (x, z, -y).
const zUpRoot = new THREE.Group();
zUpRoot.rotation.x = -Math.PI / 2;
scene.add(zUpRoot);

// Grid on Z=0 floor (XY plane in Z-up). GridHelper is in XZ plane; rotate to XY.
const grid = new THREE.GridHelper(2000, 40, 0x0f3460, 0x0f3460);
grid.rotation.x = Math.PI / 2;
zUpRoot.add(grid);

// Origin axes in Z-up coordinates (arrows point in +X, +Y, +Z of user space)
const AXES_SIZE = 150;
const _O = new THREE.Vector3();
zUpRoot.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), _O, AXES_SIZE, 0xff4444, 25, 10));
zUpRoot.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), _O, AXES_SIZE, 0x44ff44, 25, 10));
zUpRoot.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), _O, AXES_SIZE, 0x4488ff, 25, 10));

function makeAxisLabel(text, color, position) {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 52px sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 32);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false })
  );
  sprite.position.copy(position);
  sprite.scale.setScalar(28);
  zUpRoot.add(sprite);
}
makeAxisLabel('X', '#ff6666', new THREE.Vector3(AXES_SIZE + 16, 0, 0));
makeAxisLabel('Y', '#66ff66', new THREE.Vector3(0, AXES_SIZE + 16, 0));
makeAxisLabel('Z', '#6699ff', new THREE.Vector3(0, 0, AXES_SIZE + 16));

// ─── Models container ─────────────────────────────────────────────────────────
// One THREE.Group per loaded file, each with matrixAutoUpdate=false.
// Translation is accumulated per-model via matrix.multiply().
const modelsContainer = new THREE.Group();
zUpRoot.add(modelsContainer);

// ─── Selection state ──────────────────────────────────────────────────────────
// Direct object reference (not just a name string) per spec §2.
let selectedGroup = null;

const btnDelete = document.getElementById('btn-delete');
const btnMove   = document.getElementById('btn-move');
const selLabel  = document.getElementById('selection-label');

function selectGroup(group) {
  modelsContainer.traverse(obj => {
    if (obj.isMesh) obj.material.emissive.set(0x000000);
  });
  selectedGroup = group;
  const has = group !== null;
  btnDelete.disabled = !has;
  btnMove.disabled   = !has;
  if (has) {
    group.traverse(obj => {
      if (obj.isMesh) obj.material.emissive.set(0x2255aa);
    });
    selLabel.textContent = `選択中: ${group.name}`;
  } else {
    selLabel.textContent = '';
  }
}

// ─── Resource disposal ────────────────────────────────────────────────────────
const TEXTURE_KEYS = [
  'map', 'specularMap', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap',
  'alphaMap', 'aoMap', 'emissiveMap', 'envMap', 'lightMap', 'displacementMap',
];

function disposeMesh(obj) {
  obj.geometry.dispose();
  const mat = obj.material;
  if (mat) {
    for (const key of TEXTURE_KEYS) {
      if (mat[key]) mat[key].dispose();
    }
    mat.dispose();
  }
}

function deleteSelected() {
  if (!selectedGroup) return;
  selectedGroup.traverse(obj => { if (obj.isMesh) disposeMesh(obj); });
  modelsContainer.remove(selectedGroup);
  selectGroup(null);
}

// ─── Raycasting ───────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function findModelGroup(mesh) {
  let obj = mesh;
  while (obj.parent && obj.parent !== modelsContainer) obj = obj.parent;
  return obj.parent === modelsContainer ? obj : null;
}

function handleCanvasClick(e) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = [];
  modelsContainer.traverse(obj => { if (obj.isMesh) meshes.push(obj); });
  const hits = raycaster.intersectObjects(meshes, false);
  selectGroup(hits.length > 0 ? findModelGroup(hits[0].object) : null);
}

// ─── Camera controls ─────────────────────────────────────────────────────────
let isDragging = false;
let isRightDragging = false;
let lastMouse = { x: 0, y: 0 };
let mouseDownPos = { x: 0, y: 0 };
let didDrag = false;
const DRAG_THRESHOLD = 5;
const spherical = new THREE.Spherical().setFromVector3(INITIAL_CAM_POS);
const cameraTarget = new THREE.Vector3();

function updateCamera() {
  camera.position.copy(new THREE.Vector3().setFromSpherical(spherical).add(cameraTarget));
  camera.lookAt(cameraTarget);
}
updateCamera();

const canvas = renderer.domElement;

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) { isDragging = true; didDrag = false; mouseDownPos = { x: e.clientX, y: e.clientY }; }
  if (e.button === 2) isRightDragging = true;
  lastMouse = { x: e.clientX, y: e.clientY };
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    if (!didDrag) {
      const rect = canvas.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top  && e.clientY <= rect.bottom) {
        handleCanvasClick(e);
      }
    }
    isDragging = false;
    didDrag = false;
  }
  if (e.button === 2) isRightDragging = false;
});

window.addEventListener('mousemove', (e) => {
  const dx = e.clientX - lastMouse.x;
  const dy = e.clientY - lastMouse.y;
  lastMouse = { x: e.clientX, y: e.clientY };

  if (isDragging) {
    if (Math.abs(e.clientX - mouseDownPos.x) > DRAG_THRESHOLD ||
        Math.abs(e.clientY - mouseDownPos.y) > DRAG_THRESHOLD) didDrag = true;
    spherical.theta -= dx * 0.005;
    spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi - dy * 0.005));
    updateCamera();
  }

  if (isRightDragging) {
    const scale = spherical.radius * 0.001;
    const right = new THREE.Vector3()
      .crossVectors(camera.getWorldDirection(new THREE.Vector3()), camera.up)
      .normalize();
    cameraTarget.addScaledVector(right, -dx * scale);
    cameraTarget.addScaledVector(camera.up.clone().normalize(), dy * scale);
    updateCamera();
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  spherical.radius = Math.max(1, Math.min(1e7, spherical.radius * (1 + e.deltaY * 0.001)));
  updateCamera();
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('resize', () => {
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});

(function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
})();

// ─── Model loading ────────────────────────────────────────────────────────────
const loadingOverlay = document.getElementById('loading-overlay');
function showLoading(v) { loadingOverlay.classList.toggle('visible', v); }

function fitCamera() {
  modelsContainer.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(modelsContainer);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  cameraTarget.copy(center);
  spherical.radius = Math.max(size.x, size.y, size.z) * 2.5;
  updateCamera();
}

function createModelGroup(name) {
  const group = new THREE.Group();
  group.name = name;
  group.matrixAutoUpdate = false;
  modelsContainer.add(group);
  return group;
}

function addMeshToGroup(group, geometry, color) {
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({
    color: color ?? 0x4a90d9,
    specular: 0x222222,
    shininess: 40,
    side: THREE.DoubleSide,
  }));
  group.add(mesh);
}

async function loadSTL(buffer, name) {
  const isFirst = modelsContainer.children.length === 0;
  const group = createModelGroup(name);
  addMeshToGroup(group, new STLLoader().parse(buffer));
  if (isFirst) fitCamera();
}

let _occtInstance = null;
async function getOcct() {
  if (!_occtInstance) {
    _occtInstance = await occtimportjs({
      locateFile: (f) => `./node_modules/occt-import-js/dist/${f}`,
    });
  }
  return _occtInstance;
}

async function loadSTEP(buffer, name) {
  const occt = await getOcct();
  const result = occt.ReadStepFile(new Uint8Array(buffer), null);
  if (!result.success) throw new Error('STEP ファイルのパースに失敗しました。');

  const isFirst = modelsContainer.children.length === 0;
  const group = createModelGroup(name);

  for (const m of result.meshes) {
    const geo = new THREE.BufferGeometry();
    // Copy into plain Float32Array to release WASM memory view (avoid lingering reference)
    geo.setAttribute('position',
      new THREE.Float32BufferAttribute(new Float32Array(m.attributes.position.array), 3));
    if (m.attributes.normal) {
      geo.setAttribute('normal',
        new THREE.Float32BufferAttribute(new Float32Array(m.attributes.normal.array), 3));
    }
    if (m.index) {
      geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.index.array), 1));
    }
    const color = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : null;
    addMeshToGroup(group, geo, color);
  }

  if (isFirst) fitCamera();
}

async function handleFile(buffer, fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  if (ext === 'stl') await loadSTL(buffer, fileName);
  else await loadSTEP(buffer, fileName);
}

// ─── IPC ─────────────────────────────────────────────────────────────────────
window.electronAPI.onLoadModel(async ({ fileName, buffer }) => {
  showLoading(true);
  try { await handleFile(buffer, fileName); }
  catch (err) { alert(`読み込みエラー: ${err.message}`); }
  finally { showLoading(false); }
});

// ─── Drag & Drop ─────────────────────────────────────────────────────────────
const dropOverlay = document.getElementById('drop-overlay');
container.addEventListener('dragover', (e) => { e.preventDefault(); dropOverlay.classList.add('visible'); });
container.addEventListener('dragleave', () => dropOverlay.classList.remove('visible'));
container.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('visible');
  for (const file of Array.from(e.dataTransfer.files)) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['step', 'stp', 'stl'].includes(ext)) continue;
    showLoading(true);
    try { await handleFile(await file.arrayBuffer(), file.name); }
    catch (err) { alert(`読み込みエラー: ${err.message}`); }
    finally { showLoading(false); }
  }
});

// ─── Toolbar ─────────────────────────────────────────────────────────────────
document.getElementById('btn-open').addEventListener('click', () => window.electronAPI.openFileDialog());
document.getElementById('btn-delete').addEventListener('click', deleteSelected);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' && selectedGroup && document.activeElement.tagName !== 'INPUT') {
    deleteSelected();
  }
});

document.getElementById('btn-reset').addEventListener('click', () => {
  spherical.setFromVector3(INITIAL_CAM_POS);
  cameraTarget.set(0, 0, 0);
  updateCamera();
  if (modelsContainer.children.length > 0) fitCamera();
});

// ─── Move dialog（相対値・選択モデルに適用）──────────────────────────────────
// 仕様§4: 入力値はΔ（相対量）、適用後0にリセット、選択時のみ有効
const moveDialog = document.getElementById('move-dialog');

document.getElementById('btn-move').addEventListener('click', () => {
  document.getElementById('move-x').value = '0';
  document.getElementById('move-y').value = '0';
  document.getElementById('move-z').value = '0';
  moveDialog.classList.add('visible');
  document.getElementById('move-x').focus();
});

document.getElementById('move-cancel').addEventListener('click', () => {
  moveDialog.classList.remove('visible');
});

document.getElementById('move-ok').addEventListener('click', () => {
  if (!selectedGroup) { moveDialog.classList.remove('visible'); return; }
  const dx = parseFloat(document.getElementById('move-x').value) || 0;
  const dy = parseFloat(document.getElementById('move-y').value) || 0;
  const dz = parseFloat(document.getElementById('move-z').value) || 0;
  // Accumulate relative delta into the model's matrix
  selectedGroup.matrix.multiply(new THREE.Matrix4().makeTranslation(dx, dy, dz));
  selectedGroup.matrixWorldNeedsUpdate = true;
  moveDialog.classList.remove('visible');
});

// ─── Export STL ───────────────────────────────────────────────────────────────
document.getElementById('btn-export').addEventListener('click', async () => {
  if (modelsContainer.children.length === 0) {
    alert('エクスポートするモデルがありません。');
    return;
  }
  await window.electronAPI.saveStlDialog(buildSTLBuffer());
});

// Bake each model group's translation matrix into vertex positions.
// zUpRoot rotation is excluded — output stays in Z-up user coordinates.
function buildSTLBuffer() {
  const meshes = [];
  modelsContainer.traverse(obj => { if (obj.isMesh) meshes.push(obj); });

  let totalTri = 0;
  for (const m of meshes) {
    const geo = m.geometry;
    totalTri += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
  }

  const buf  = new ArrayBuffer(84 + totalTri * 50);
  const view = new DataView(buf);
  let off = 80;
  view.setUint32(off, totalTri, true); off += 4;

  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const n  = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();

  for (const m of meshes) {
    // modelGroup.matrix (accumulated translation) × mesh.matrix (identity)
    const exportMatrix = new THREE.Matrix4().multiplyMatrices(m.parent.matrix, m.matrix);
    const geo = m.geometry.clone();
    geo.applyMatrix4(exportMatrix);

    const pos = geo.attributes.position;
    const idx = geo.index ? geo.index.array : null;
    const triCount = idx ? idx.length / 3 : pos.count / 3;

    for (let i = 0; i < triCount; i++) {
      const ia = idx ? idx[i*3]   : i*3;
      const ib = idx ? idx[i*3+1] : i*3+1;
      const ic = idx ? idx[i*3+2] : i*3+2;
      vA.fromBufferAttribute(pos, ia);
      vB.fromBufferAttribute(pos, ib);
      vC.fromBufferAttribute(pos, ic);
      e1.subVectors(vB, vA); e2.subVectors(vC, vA);
      n.crossVectors(e1, e2).normalize();
      for (const v of [n, vA, vB, vC]) {
        view.setFloat32(off, v.x, true); off += 4;
        view.setFloat32(off, v.y, true); off += 4;
        view.setFloat32(off, v.z, true); off += 4;
      }
      view.setUint16(off, 0, true); off += 2;
    }
  }
  return buf;
}
