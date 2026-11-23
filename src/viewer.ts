// Three.js 3D view: ground, building-area wireframe, floor lines, walls and slabs.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Project, floorBase, planForFloor, totalHeight } from './model';
import { enclosedFaces, V2 } from './geometry';

export type ViewMode = 'plan' | 'structural' | 'detailed';

export class Viewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  private content = new THREE.Group();
  private ro: ResizeObserver;
  private lastBase = -1;
  private disposed = false;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x232323);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 1.5);
    this.scene.add(sun);
    this.scene.add(this.content);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    const loop = () => {
      if (this.disposed) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.disposed = true;
    this.ro.disconnect();
    this.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clear() {
    this.content.traverse(o => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose();
    });
    this.content.clear();
  }

  frame(p: Project) {
    const L = p.baseLength, H = totalHeight(p);
    const r = Math.max(L, H) * 1.6;
    this.camera.position.set(L * 0.5 + r, H * 0.6 + r * 0.6, L * 0.5 + r);
    this.controls.target.set(L / 2, H / 3, L / 2);
    this.camera.near = Math.max(0.01, r / 1e4);
    this.camera.far = r * 100;
    this.camera.updateProjectionMatrix();
  }

  /** Rebuild the scene. World: x = plan x * L, z = (1 - plan y) * L, y = up. */
  update(p: Project, mode: ViewMode, selectedFloor: string | null) {
    this.clear();
    const L = p.baseLength, H = totalHeight(p);
    if (this.lastBase !== L) { this.frame(p); this.lastBase = L; }

    // ground plane
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(L * 6, L * 6),
      new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 1 }),
    );
    g.rotation.x = -Math.PI / 2;
    g.position.set(L / 2, -0.001 * L, L / 2);
    this.content.add(g);

    // building area: square at ground, at every floor and at top, plus vertical edges
    const white = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
    const yellow = new THREE.LineBasicMaterial({ color: 0xffd400 });
    const sq = (y: number, mat: THREE.LineBasicMaterial) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, y, 0), new THREE.Vector3(L, y, 0), new THREE.Vector3(L, y, L), new THREE.Vector3(0, y, L),
      ]);
      this.content.add(new THREE.LineLoop(geo, mat));
    };
    let y = 0;
    p.floors.forEach(f => {
      sq(y, f.id === selectedFloor ? yellow : white);
      y += f.height;
    });
    sq(H, white);
    if (selectedFloor) {
      const i = p.floors.findIndex(f => f.id === selectedFloor);
      if (i >= 0) sq(floorBase(p, i + 1), yellow);
    }
    const vgeo = new THREE.BufferGeometry().setFromPoints(
      [[0, 0], [L, 0], [L, L], [0, L]].flatMap(([x, z]) => [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, H, z)]),
    );
    this.content.add(new THREE.LineSegments(vgeo, white));

    const toW = (v: V2, yy: number) => new THREE.Vector3(v.x * L, yy, (1 - v.y) * L);

    if (mode === 'plan') {
      // stacked 2D plans
      p.floors.forEach((f, i) => {
        const plan = planForFloor(p, f.id);
        if (!plan) return;
        const yy = floorBase(p, i) + 0.002 * L;
        const pts = new Map(plan.points.map(pt => [pt.id, pt]));
        const arr: THREE.Vector3[] = [];
        plan.segments.forEach(s => arr.push(toW(pts.get(s.a)!, yy), toW(pts.get(s.b)!, yy)));
        const lm = new THREE.LineBasicMaterial({ color: f.id === selectedFloor ? 0xffd400 : 0x7fc8ff });
        this.content.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(arr), lm));
        for (const face of enclosedFaces(plan)) {
          const shape = new THREE.Shape(face.map(v => new THREE.Vector2(v.x * L, v.y * L)));
          const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({
            color: 0x3a7bd5, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false,
          }));
          // shape is in (x, y) -> map to world (x, z = L - y)
          m.rotation.x = -Math.PI / 2;
          m.position.set(0, yy, L);
          this.content.add(m);
        }
      });
      return;
    }

    // structural / detailed: walls + slabs
    const wallMat = new THREE.MeshStandardMaterial({ color: mode === 'detailed' ? 0xd8d2c4 : 0xbdbdbd, roughness: 0.9 });
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
    const addEdges = (m: THREE.Mesh) => {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 20), edgeMat);
      e.position.copy(m.position); e.rotation.copy(m.rotation); e.quaternion.copy(m.quaternion);
      this.content.add(e);
    };

    p.floors.forEach((f, i) => {
      const plan = planForFloor(p, f.id);
      if (!plan) return;
      const base = floorBase(p, i);
      const t = plan.wallThickness;
      const pts = new Map(plan.points.map(pt => [pt.id, pt]));
      const slabT = plan.floorEnabled ? Math.min(plan.floorThickness, f.height * 0.9) : 0;

      // slab at the bottom of this floor, under every enclosed area
      if (slabT > 0) {
        for (const face of enclosedFaces(plan)) {
          const shape = new THREE.Shape(face.map(v => new THREE.Vector2(v.x * L, v.y * L)));
          const geo = new THREE.ExtrudeGeometry(shape, { depth: slabT, bevelEnabled: false });
          const m = new THREE.Mesh(geo, slabMat);
          m.rotation.x = -Math.PI / 2; // extrusion (z) -> up
          m.position.set(0, base, L);
          this.content.add(m); addEdges(m);
        }
      }

      // walls: box per segment, centred on the line, extended by t/2 to close corners
      for (const s of plan.segments) {
        const A = pts.get(s.a)!, B = pts.get(s.b)!;
        const a = toW(A, 0), b = toW(B, 0);
        const len = a.distanceTo(b);
        if (len < 1e-6) continue;
        const h = f.height - slabT;
        const geo = new THREE.BoxGeometry(len + t, h, t);
        const m = new THREE.Mesh(geo, wallMat);
        m.position.set((a.x + b.x) / 2, base + slabT + h / 2, (a.z + b.z) / 2);
        m.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
        this.content.add(m); addEdges(m);
      }
      // a single lone point = a pillar of wall thickness
      const used = new Set(plan.segments.flatMap(s => [s.a, s.b]));
      for (const pt of plan.points) {
        if (used.has(pt.id)) continue;
        const h = f.height - slabT;
        const m = new THREE.Mesh(new THREE.BoxGeometry(t, h, t), wallMat);
        const w = toW(pt, 0);
        m.position.set(w.x, base + slabT + h / 2, w.z);
        this.content.add(m); addEdges(m);
      }
    });
  }
}
