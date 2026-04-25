import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass }    from 'three/examples/jsm/postprocessing/OutlinePass.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Theme = 'dark' | 'light' | 'system';
type EffectiveTheme = 'dark' | 'light';

interface ThemeColors {
  sceneBg:    number;
  gridCenter: number;
  gridLine:   number;
}

const THEME_COLORS: Record<EffectiveTheme, ThemeColors> = {
  dark:  { sceneBg: 0x1a1a2e, gridCenter: 0x0f3460, gridLine: 0x0f3460 },
  light: { sceneBg: 0xd8dce8, gridCenter: 0x8890a8, gridLine: 0xaab4cc },
};

const AXES_SIZE      = 150;
const DRAG_THRESHOLD = 5;

// ─── SceneManager ─────────────────────────────────────────────────────────────

/**
 * Owns the Three.js renderer, scene, camera, and camera controls.
 *
 * ### Coordinate system
 * All scene content lives inside `zUpRoot` (rotation.x = -π/2) so that the
 * authoring coordinate system is right-hand Z-up:
 *   X = right,  Y = depth,  Z = up
 *
 * ### Camera-Relative Rendering (RTE)
 * Every frame `applyRTE()` shifts `zUpRoot.position` by −cameraTarget and
 * sets the camera at `spherical` offset from origin.  This keeps GPU vertex
 * coordinates small regardless of where models are placed, eliminating
 * float32 jitter at distances > ~1 m from the world origin.
 *
 * ### Selection outline
 * Selection is visualised via Three.js `OutlinePass` (post-processing).
 * Call `setSelection(group)` to highlight a model; pass `null` to clear.
 */
export class SceneManager {
  // ── Public read-only handles ─────────────────────────────────────────────
  readonly renderer:         THREE.WebGLRenderer;
  readonly scene:            THREE.Scene;
  readonly camera:           THREE.PerspectiveCamera;
  readonly zUpRoot:          THREE.Group;
  /** Attach ModelObject.group here. Raycasting is scoped to this container. */
  readonly modelsContainer:  THREE.Group;

  /** Set by the owner; called on genuine left-clicks (not drag-ends). */
  onClick: ((event: MouseEvent) => void) | null = null;

  // ── Private ──────────────────────────────────────────────────────────────
  private grid:          THREE.GridHelper;
  private readonly composer:    EffectComposer;
  private readonly outlinePass: OutlinePass;

  // Camera state — applyRTE() translates these to Three.js objects each frame
  private readonly spherical    = new THREE.Spherical(500, Math.PI / 3, 0);
  private readonly cameraTarget = new THREE.Vector3();

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer   = new THREE.Vector2();

  private isDragging      = false;
  private isRightDragging = false;
  private lastMouse       = { x: 0, y: 0 };
  private mouseDownPos    = { x: 0, y: 0 };
  private _didDrag        = false;

  private animFrameId = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly sysDarkMQ: MediaQueryList;
  private savedTheme: Theme = 'dark';

  constructor(private readonly container: HTMLElement) {
    const w = container.clientWidth;
    const h = container.clientHeight;

    // ── Renderer (logarithmicDepthBuffer for 0.0001 mm precision) ────────
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    // ── Scene ─────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(THEME_COLORS.dark.sceneBg);

    // ── Camera — near=0.001 mm, far=10,000,000 mm ─────────────────────────
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.001, 1e7);

    // ── Lighting (world space) ─────────────────────────────────────────────
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.8);
    d1.position.set(500, 800, 500);
    this.scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.3);
    d2.position.set(-500, -200, -500);
    this.scene.add(d2);

    // ── Z-up root ─────────────────────────────────────────────────────────
    this.zUpRoot = new THREE.Group();
    this.zUpRoot.rotation.x = -Math.PI / 2;
    this.scene.add(this.zUpRoot);

    // ── Grid on Z=0 (XY plane in Z-up space) ─────────────────────────────
    this.grid = this.createGrid(THEME_COLORS.dark.gridCenter, THEME_COLORS.dark.gridLine);
    this.zUpRoot.add(this.grid);

    // ── Origin axes ───────────────────────────────────────────────────────
    const O = new THREE.Vector3();
    this.zUpRoot.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), O, AXES_SIZE, 0xff4444, 25, 10));
    this.zUpRoot.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), O, AXES_SIZE, 0x44ff44, 25, 10));
    this.zUpRoot.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), O, AXES_SIZE, 0x4488ff, 25, 10));
    this.addAxisLabel('X', '#ff6666', new THREE.Vector3(AXES_SIZE + 16, 0, 0));
    this.addAxisLabel('Y', '#66ff66', new THREE.Vector3(0, AXES_SIZE + 16, 0));
    this.addAxisLabel('Z', '#6699ff', new THREE.Vector3(0, 0, AXES_SIZE + 16));

    // ── Models container ──────────────────────────────────────────────────
    this.modelsContainer = new THREE.Group();
    this.zUpRoot.add(this.modelsContainer);

    // ── Post-processing: OutlinePass for selection highlight ──────────────
    const renderPass   = new RenderPass(this.scene, this.camera);
    this.outlinePass   = new OutlinePass(new THREE.Vector2(w, h), this.scene, this.camera);
    this.outlinePass.edgeStrength  = 3.0;
    this.outlinePass.edgeThickness = 1.0;
    this.outlinePass.visibleEdgeColor.set(0x4488ff);
    this.outlinePass.hiddenEdgeColor.set(0x1144aa);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(renderPass);
    this.composer.addPass(this.outlinePass);

    // ── Event listeners ───────────────────────────────────────────────────
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);

    this.sysDarkMQ = window.matchMedia('(prefers-color-scheme: dark)');
    this.sysDarkMQ.addEventListener('change', () => {
      if (this.savedTheme === 'system') this.applyTheme('system');
    });

    // ── Render loop ───────────────────────────────────────────────────────
    this.animate();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** True if the last mousedown → mouseup was a drag (not a click). */
  get didDrag(): boolean {
    return this._didDrag;
  }

  /**
   * Highlight the selected model with an outline (OutlinePass).
   * Pass null to clear the selection.
   */
  setSelection(group: THREE.Group | null): void {
    this.outlinePass.selectedObjects = group ? [group] : [];
  }

  /**
   * Apply a theme to both the DOM and the Three.js scene.
   * Persists the choice to localStorage.
   */
  applyTheme(theme: Theme): void {
    this.savedTheme = theme;
    const effective: EffectiveTheme =
      theme === 'system' ? (this.sysDarkMQ.matches ? 'dark' : 'light') : theme;
    const c = THEME_COLORS[effective];

    document.body.setAttribute('data-theme', effective);
    (this.scene.background as THREE.Color).set(c.sceneBg);
    this.rebuildGrid(c.gridCenter, c.gridLine);
    localStorage.setItem('theme', theme);

    const sel = document.getElementById('theme-select') as HTMLSelectElement | null;
    if (sel && sel.value !== theme) sel.value = theme;
  }

  /**
   * Fit camera to the bounding box of all models in `modelsContainer`.
   * No-op when the container is empty.
   *
   * RTE-aware: uses the RTE-shifted worldMatrix to find the model center,
   * then updates cameraTarget so models are centred in view.
   */
  fitCamera(): void {
    this.applyRTE();
    this.zUpRoot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.modelsContainer);
    if (box.isEmpty()) return;

    // In RTE space:  box_center = true_world_center − cameraTarget
    // Therefore:     true_world_center = box_center + cameraTarget
    const rteCenter = box.getCenter(new THREE.Vector3());
    this.cameraTarget.add(rteCenter);

    const size = box.getSize(new THREE.Vector3());
    this.spherical.radius = Math.max(size.x, size.y, size.z) * 2.5;
  }

  /**
   * Raycast from a MouseEvent into `modelsContainer`.
   * Returns the direct-child THREE.Group of modelsContainer that was hit,
   * or null if no model was hit.
   */
  pickGroup(event: MouseEvent): THREE.Group | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x =  ((event.clientX - rect.left) / rect.width)  * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const meshes: THREE.Object3D[] = [];
    this.modelsContainer.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) meshes.push(obj);
    });
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    return this.findDirectChild(hits[0].object);
  }

  /** Release all renderer resources and unbind events. */
  dispose(): void {
    cancelAnimationFrame(this.animFrameId);
    this.resizeObserver.disconnect();
    this.unbindEvents();
    this.renderer.dispose();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Camera-Relative Rendering (RTE) — called every frame before rendering.
   *
   * Shift `zUpRoot` by −cameraTarget so the camera pivot sits at world origin.
   * Camera position = spherical offset from origin (no cameraTarget added).
   * Because GPU receives only the difference vector, float32 precision holds
   * even when models are hundreds of metres from the scene origin.
   */
  private applyRTE(): void {
    this.zUpRoot.position.set(
      -this.cameraTarget.x,
      -this.cameraTarget.y,
      -this.cameraTarget.z,
    );
    this.camera.position.setFromSpherical(this.spherical);
    this.camera.lookAt(0, 0, 0);
  }

  private createGrid(centerColor: number, lineColor: number): THREE.GridHelper {
    const g = new THREE.GridHelper(2000, 40, centerColor, lineColor);
    g.rotation.x = Math.PI / 2;
    return g;
  }

  private rebuildGrid(centerColor: number, lineColor: number): void {
    this.zUpRoot.remove(this.grid);
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.grid = this.createGrid(centerColor, lineColor);
    this.zUpRoot.add(this.grid);
  }

  private addAxisLabel(text: string, color: string, position: THREE.Vector3): void {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const ctx = cv.getContext('2d')!;
    ctx.font = 'bold 52px sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 32, 32);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }),
    );
    sprite.position.copy(position);
    sprite.scale.setScalar(28);
    this.zUpRoot.add(sprite);
  }

  /** Walk up the hierarchy to find the direct child of modelsContainer. */
  private findDirectChild(obj: THREE.Object3D): THREE.Group | null {
    let cur = obj;
    while (cur.parent && cur.parent !== this.modelsContainer) {
      cur = cur.parent;
    }
    return cur.parent === this.modelsContainer ? (cur as THREE.Group) : null;
  }

  private animate(): void {
    this.animFrameId = requestAnimationFrame(() => this.animate());
    this.applyRTE();
    this.composer.render();
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.outlinePass.resolution.set(w, h);
  }

  // ── Mouse event handlers ──────────────────────────────────────────────────

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.isDragging   = true;
      this._didDrag     = false;
      this.mouseDownPos = { x: e.clientX, y: e.clientY };
    }
    if (e.button === 2) this.isRightDragging = true;
    this.lastMouse = { x: e.clientX, y: e.clientY };
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      if (!this._didDrag) this.onClick?.(e);
      this.isDragging = false;
      this._didDrag   = false;
    }
    if (e.button === 2) this.isRightDragging = false;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    const dx = e.clientX - this.lastMouse.x;
    const dy = e.clientY - this.lastMouse.y;
    this.lastMouse = { x: e.clientX, y: e.clientY };

    if (this.isDragging) {
      if (
        Math.abs(e.clientX - this.mouseDownPos.x) > DRAG_THRESHOLD ||
        Math.abs(e.clientY - this.mouseDownPos.y) > DRAG_THRESHOLD
      ) {
        this._didDrag = true;
      }
      this.spherical.theta -= dx * 0.005;
      this.spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this.spherical.phi - dy * 0.005));
    }

    if (this.isRightDragging) {
      const scale = this.spherical.radius * 0.001;
      const right = new THREE.Vector3()
        .crossVectors(this.camera.getWorldDirection(new THREE.Vector3()), this.camera.up)
        .normalize();
      this.cameraTarget.addScaledVector(right, -dx * scale);
      this.cameraTarget.addScaledVector(this.camera.up.clone().normalize(), dy * scale);
    }
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.spherical.radius = Math.max(1, Math.min(1e7, this.spherical.radius * (1 + e.deltaY * 0.001)));
  };

  private readonly onContextMenu = (e: Event): void => e.preventDefault();

  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener('mousedown',   this.onMouseDown);
    c.addEventListener('contextmenu', this.onContextMenu);
    c.addEventListener('wheel',       this.onWheel, { passive: false });
    window.addEventListener('mouseup',   this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
  }

  private unbindEvents(): void {
    const c = this.canvas;
    c.removeEventListener('mousedown',   this.onMouseDown);
    c.removeEventListener('contextmenu', this.onContextMenu);
    c.removeEventListener('wheel',       this.onWheel);
    window.removeEventListener('mouseup',   this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
  }
}
