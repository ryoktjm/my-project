import * as THREE from 'three';

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

const AXES_SIZE = 150;
const INITIAL_CAM_POS = new THREE.Vector3(0, 200, 500);
const DRAG_THRESHOLD = 5;

// ─── SceneManager ─────────────────────────────────────────────────────────────

/**
 * Owns the Three.js renderer, scene, camera, and camera controls.
 * All scene content lives inside `zUpRoot` (rotation.x = -π/2) so that
 * the entire authoring coordinate system is right-hand Z-up:
 *   X = 右 (right),  Y = 奥行き (depth),  Z = 上 (up)
 *
 * The `modelsContainer` group (child of zUpRoot) is where ModelObjects attach.
 */
export class SceneManager {
  // ── Public read-only handles ─────────────────────────────────────────────
  readonly renderer: THREE.WebGLRenderer;
  readonly scene:    THREE.Scene;
  readonly camera:   THREE.PerspectiveCamera;
  readonly zUpRoot:  THREE.Group;
  /** Attach ModelObject.group here. Raycasting is scoped to this container. */
  readonly modelsContainer: THREE.Group;

  /** Set by the owner; called on genuine left-clicks (not drag-ends). */
  onClick: ((event: MouseEvent) => void) | null = null;

  // ── Private ──────────────────────────────────────────────────────────────
  private grid: THREE.GridHelper;
  private readonly spherical   = new THREE.Spherical().setFromVector3(INITIAL_CAM_POS);
  private readonly cameraTarget = new THREE.Vector3();
  private readonly raycaster   = new THREE.Raycaster();
  private readonly pointer     = new THREE.Vector2();

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
    // ── Renderer (logarithmicDepthBuffer for 0.0001 mm precision) ────────
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    // ── Scene ─────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(THEME_COLORS.dark.sceneBg);

    // ── Camera — near=0.001 mm, far=10,000,000 mm ─────────────────────────
    this.camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.001,
      1e7,
    );
    this.camera.position.copy(INITIAL_CAM_POS);
    this.camera.lookAt(0, 0, 0);

    // ── Lighting (world space) ─────────────────────────────────────────────
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.8);
    d1.position.set(500, 800, 500);
    this.scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.3);
    d2.position.set(-500, -200, -500);
    this.scene.add(d2);

    // ── Z-up root ─────────────────────────────────────────────────────────
    // rotation.x = -π/2  maps  Z-up (x,y,z) → Three.js Y-up (x, z, -y)
    this.zUpRoot = new THREE.Group();
    this.zUpRoot.rotation.x = -Math.PI / 2;
    this.scene.add(this.zUpRoot);

    // ── Grid on Z=0 (XY plane in Z-up space) ─────────────────────────────
    // GridHelper is in XZ plane by default; rotate.x = +π/2 to place in XY.
    this.grid = this.createGrid(
      THEME_COLORS.dark.gridCenter,
      THEME_COLORS.dark.gridLine,
    );
    this.zUpRoot.add(this.grid);

    // ── Origin axes (authored in Z-up space) ──────────────────────────────
    const O = new THREE.Vector3();
    this.zUpRoot.add(
      new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), O, AXES_SIZE, 0xff4444, 25, 10),
    );
    this.zUpRoot.add(
      new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), O, AXES_SIZE, 0x44ff44, 25, 10),
    );
    this.zUpRoot.add(
      new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), O, AXES_SIZE, 0x4488ff, 25, 10),
    );
    this.addAxisLabel('X', '#ff6666', new THREE.Vector3(AXES_SIZE + 16, 0, 0));
    this.addAxisLabel('Y', '#66ff66', new THREE.Vector3(0, AXES_SIZE + 16, 0));
    this.addAxisLabel('Z', '#6699ff', new THREE.Vector3(0, 0, AXES_SIZE + 16));

    // ── Models container ──────────────────────────────────────────────────
    this.modelsContainer = new THREE.Group();
    this.zUpRoot.add(this.modelsContainer);

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
   * Apply a theme to both the DOM and the Three.js scene.
   * Persists the choice to localStorage.
   */
  applyTheme(theme: Theme): void {
    this.savedTheme = theme;
    const effective: EffectiveTheme =
      theme === 'system'
        ? (this.sysDarkMQ.matches ? 'dark' : 'light')
        : theme;
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
   */
  fitCamera(): void {
    this.modelsContainer.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.modelsContainer);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    this.cameraTarget.copy(center);
    this.spherical.radius = Math.max(size.x, size.y, size.z) * 2.5;
    this.updateCamera();
  }

  /**
   * Raycast from a MouseEvent into `modelsContainer`.
   * Returns the direct-child THREE.Group of modelsContainer that was hit,
   * or null if no model was hit.
   */
  pickGroup(event: MouseEvent): THREE.Group | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width)  * 2 - 1;
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

  private addAxisLabel(
    text: string,
    color: string,
    position: THREE.Vector3,
  ): void {
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

  private updateCamera(): void {
    this.camera.position
      .copy(new THREE.Vector3().setFromSpherical(this.spherical))
      .add(this.cameraTarget);
    this.camera.lookAt(this.cameraTarget);
  }

  private animate(): void {
    this.animFrameId = requestAnimationFrame(() => this.animate());
    this.renderer.render(this.scene, this.camera);
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // ── Mouse event handlers ──────────────────────────────────────────────────

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.isDragging  = true;
      this._didDrag    = false;
      this.mouseDownPos = { x: e.clientX, y: e.clientY };
    }
    if (e.button === 2) this.isRightDragging = true;
    this.lastMouse = { x: e.clientX, y: e.clientY };
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      if (!this._didDrag) {
        // Genuine click — delegate to owner callback
        this.onClick?.(e);
      }
      this.isDragging  = false;
      this._didDrag    = false;
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
      this.spherical.phi = Math.max(
        0.05,
        Math.min(Math.PI - 0.05, this.spherical.phi - dy * 0.005),
      );
      this.updateCamera();
    }

    if (this.isRightDragging) {
      const scale = this.spherical.radius * 0.001;
      const right = new THREE.Vector3()
        .crossVectors(
          this.camera.getWorldDirection(new THREE.Vector3()),
          this.camera.up,
        )
        .normalize();
      this.cameraTarget.addScaledVector(right, -dx * scale);
      this.cameraTarget.addScaledVector(
        this.camera.up.clone().normalize(),
        dy * scale,
      );
      this.updateCamera();
    }
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.spherical.radius = Math.max(
      1,
      Math.min(1e7, this.spherical.radius * (1 + e.deltaY * 0.001)),
    );
    this.updateCamera();
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
