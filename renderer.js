import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

// ─── Scene setup ─────────────────────────────────────────────────────────────
const container = document.getElementById('canvas-container');

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

// near=0.001mm, far=10,000,000mm — covers 0.0001mm precision to 10km range
const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.001, 1e7);
const INITIAL_CAM_POS = new THREE.Vector3(0, 200, 500);
camera.position.copy(INITIAL_CAM_POS);
camera.lookAt(0, 0, 0);

// Lights (Three.js world space)
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight1.position.set(500, 800, 500);
scene.add(dirLight1);
const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
dirLight2.position.set(-500, -200, -500);
scene.add(dirLight2);

// ─── Z-up root ────────────────────────────────────────────────────────────────
// All scene content is authored in right-hand Z-up space (X=右, Y=奥行き, Z=上).
// rotation.x = -π/2 converts Z-up (x,y,z) → Three.js Y-up (x, z, -y).
const zUpRoot = new THREE.Group();
zUpRoot.rotation.x = -Math.PI / 2;
scene.add(zUpRoot);

// Grid on Z=0 floor in Z-up space.
// GridHelper is in XZ plane by default; rotate.x = +π/2 maps it to XY plane in Z-up.
const grid = new THREE.GridHelper(2000, 40, 0x0f3460, 0x0f3460);
grid.rotation.x = Math.PI / 2;
zUpRoot.add(grid);

// ─── Origin axes  右手系 Z-up: X×Y=Z ─────────────────────────────────────────
// Inside zUpRoot, axes are authored in Z-up coordinates directly.
// zUpRoot rotation maps them to the correct Three.js directions automatically.
const AXES_SIZE = 150;
const _O = new THREE.Vector3(0, 0, 0);

zUpRoot.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), _O, AXES_SIZE, 0xff4444, 25, 10)); // X 赤
zUpRoot.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), _O, AXES_SIZE, 0x44ff44, 25, 10)); // Y 緑 奥行き
zUpRoot.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), _O, AXES_SIZE, 0x4488ff, 25, 10)); // Z 青 垂直

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

// ─── Models group ─────────────────────────────────────────────────────────────
// Lives inside zUpRoot (Z-up space). Translation applied via THREE.Matrix4 for
// sub-millimeter precision; matrixAutoUpdate=false so we control the matrix directly.
const modelsGroup = new THREE.Group();
modelsGroup.matrixAutoUpdate = false;
zUpRoot.add(modelsGroup);

// Translation stored in Z-up user coordinates (mm)
const translation = new THREE.Vector3();

function applyTranslation() {
  modelsGroup.matrix.makeTranslation(translation.x, translation.y, translation.z);
}

// ─── State ───────────────────────────────────────────────────────────────────
let isDragging = false;
let isRightDragging = false;
let lastMouse = { x: 0, y: 0 };
let mouseDownPos = { x: 0, y: 0 };
let didDrag = false;
const DRAG_THRESHOLD = 5;
const spherical = new THREE.Spherical().setFromVector3(INITIAL_CAM_POS);
const cameraTarget = new THREE.Vector3();

// ─── Selection ───────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let selectedName = null;

function selectModel(name) {
  modelsGroup.traverse(obj => {
    if (obj.isMesh) obj.material.emissive.set(0x000000);
  });
  selectedName = name;
  if (name) {
    modelsGroup.traverse(obj => {
      if (obj.isMesh && obj.name === name) obj.material.emissive.set(0x2255aa);
    });
    document.getElementById('btn-delete').disabled = false;
    document.getElementById('selection-label').textContent = `選択中: ${name}`;
  } else {
    document.getElementById('btn-delete').disabled = true;
    document.getElementById('selection-label').textContent = '';
  }
}

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
  if (!selectedName) return;
  const toRemove = [];
  modelsGroup.traverse(obj => {
    if (obj.isMesh && obj.name === selectedName) toRemove.push(obj);
  });
  for (const obj of toRemove) {
    disposeMesh(obj);
    obj.parent.remove(obj);
  }
  selectedName = null;
  document.getElementById('btn-delete').disabled = true;
  document.getElementById('selection-label').textContent = '';
}

function handleCanvasClick(e) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = [];
  modelsGroup.traverse(obj => { if (obj.isMesh) meshes.push(obj); });
  const hits = raycaster.intersectObjects(meshes, false);
  selectModel(hits.length > 0 ? hits[0].object.name : null);
}

// ─── Camera helpers ───────────────────────────────────────────────────────────
function updateCamera() {
  camera.position.copy(new THREE.Vector3().setFromSpherical(spherical).add(cameraTarget));
  camera.lookAt(cameraTarget);
}
updateCamera();

// ─── Mouse interaction ────────────────────────────────────────────────────────
const canvas = renderer.domElement;

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    isDragging = true;
    didDrag = false;
    mouseDownPos = { x: e.clientX, y: e.clientY };
  }
  if (e.button === 2) isRightDragging = true;
  lastMouse = { x: e.clientX, y: e.clientY };
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    if (!didDrag) {
      const rect = canvas.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
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
        Math.abs(e.clientY - mouseDownPos.y) > DRAG_THRESHOLD) {
      didDrag = true;
    }
    spherical.theta -= dx * 0.005;
    spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi - dy * 0.005));
    updateCamera();
  }

  if (isRightDragging) {
    const scale = spherical.radius * 0.001;
    const right = new THREE.Vector3().crossVectors(
      camera.getWorldDirection(new THREE.Vector3()), camera.up
    ).normalize();
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

// ─── Resize ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});

// ─── Render loop ─────────────────────────────────────────────────────────────
(function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
})();

// ─── Model loading helpers ────────────────────────────────────────────────────
const loadingOverlay = document.getElementById('loading-overlay');

function showLoading(v) {
  loadingOverlay.classList.toggle('visible', v);
}

function addMesh(geometry, name) {
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({
    color: 0x4a90d9,
    specular: 0x222222,
    shininess: 40,
    side: THREE.DoubleSide,
  }));
  mesh.name = name;
  modelsGroup.add(mesh);
  if (modelsGroup.children.length === 1) fitCamera();
}

function fitCamera() {
  modelsGroup.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(modelsGroup);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  cameraTarget.copy(center);
  spherical.radius = Math.max(size.x, size.y, size.z) * 2.5;
  updateCamera();
}

async function loadSTL(buffer, name) {
  const geometry = new STLLoader().parse(buffer);
  addMesh(geometry, name);
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
  if (!result.success) {
    throw new Error('STEP ファイルのパースに失敗しました。');
  }
  for (const m of result.meshes) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) {
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    }
    if (m.index) {
      geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.index.array), 1));
    }
    const mat = new THREE.MeshPhongMaterial({
      color: m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : 0x4a90d9,
      specular: 0x222222,
      shininess: 40,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    modelsGroup.add(mesh);
    if (modelsGroup.children.length === 1) fitCamera();
  }
}

async function handleFile(buffer, fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  if (ext === 'stl') {
    await loadSTL(buffer, fileName);
  } else {
    await loadSTEP(buffer, fileName);
  }
  applyTranslation();
}

// ─── IPC: file from main process ─────────────────────────────────────────────
window.electronAPI.onLoadModel(async ({ fileName, buffer }) => {
  showLoading(true);
  try {
    await handleFile(buffer, fileName);
  } catch (err) {
    alert(`読み込みエラー: ${err.message}`);
  } finally {
    showLoading(false);
  }
});

// ─── Drag & Drop ─────────────────────────────────────────────────────────────
const dropOverlay = document.getElementById('drop-overlay');

container.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropOverlay.classList.add('visible');
});

container.addEventListener('dragleave', () => dropOverlay.classList.remove('visible'));

container.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('visible');
  for (const file of Array.from(e.dataTransfer.files)) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['step', 'stp', 'stl'].includes(ext)) continue;
    showLoading(true);
    try {
      await handleFile(await file.arrayBuffer(), file.name);
    } catch (err) {
      alert(`読み込みエラー: ${err.message}`);
    } finally {
      showLoading(false);
    }
  }
});

// ─── Toolbar ─────────────────────────────────────────────────────────────────
document.getElementById('btn-open').addEventListener('click', () => {
  window.electronAPI.openFileDialog();
});

document.getElementById('btn-delete').addEventListener('click', deleteSelected);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' && selectedName && document.activeElement.tagName !== 'INPUT') {
    deleteSelected();
  }
});

document.getElementById('btn-reset').addEventListener('click', () => {
  spherical.setFromVector3(INITIAL_CAM_POS);
  cameraTarget.set(0, 0, 0);
  updateCamera();
  if (modelsGroup.children.length > 0) fitCamera();
});

// ─── Move dialog ──────────────────────────────────────────────────────────────
const moveDialog = document.getElementById('move-dialog');

document.getElementById('btn-move').addEventListener('click', () => {
  document.getElementById('move-x').value = translation.x.toFixed(4);
  document.getElementById('move-y').value = translation.y.toFixed(4);
  document.getElementById('move-z').value = translation.z.toFixed(4);
  moveDialog.classList.add('visible');
});

document.getElementById('move-cancel').addEventListener('click', () => {
  moveDialog.classList.remove('visible');
});

document.getElementById('move-ok').addEventListener('click', () => {
  translation.x = parseFloat(document.getElementById('move-x').value) || 0;
  translation.y = parseFloat(document.getElementById('move-y').value) || 0;
  translation.z = parseFloat(document.getElementById('move-z').value) || 0;
  applyTranslation();
  moveDialog.classList.remove('visible');
});

// ─── Export STL ───────────────────────────────────────────────────────────────
document.getElementById('btn-export').addEventListener('click', async () => {
  if (modelsGroup.children.length === 0) {
    alert('エクスポートするモデルがありません。');
    return;
  }
  const stlBuffer = buildSTLBuffer();
  await window.electronAPI.saveStlDialog(stlBuffer);
});

// Export in Z-up user coordinates: apply translation matrix to vertices only.
// zUpRoot rotation is intentionally excluded — STL stays in Z-up space.
function buildSTLBuffer() {
  const meshes = [];
  modelsGroup.traverse((obj) => { if (obj.isMesh) meshes.push(obj); });

  let totalTri = 0;
  for (const m of meshes) {
    const geo = m.geometry;
    totalTri += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
  }

  const buf = new ArrayBuffer(84 + totalTri * 50);
  const view = new DataView(buf);
  let off = 80;
  view.setUint32(off, totalTri, true); off += 4;

  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const n  = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();

  for (const m of meshes) {
    const geo = m.geometry.clone();
    // Bake translation + mesh local transform into vertices at export time
    const exportMatrix = new THREE.Matrix4().multiplyMatrices(modelsGroup.matrix, m.matrix);
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
