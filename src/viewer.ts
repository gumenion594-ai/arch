// Three.js 3D view: ground, building-area wireframe, floor lines, walls and slabs.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Building, Project, elevation, segKind } from './model';
import { enclosedFaces, sampleSeg, V2 } from './geometry';
import { buildStructure, planAtLevel, toWorld } from './build3d';

export type ViewMode = 'plan' | 'structural' | 'detailed';

export class Viewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  private content = new THREE.Group();
  private ro: ResizeObserver;
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

  /** Bounds of all buildings: [minX, maxX, minZ, maxZ, minY, maxY]. */
  private bounds(p: Project) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = 0, y1 = 0;
    for (const b of p.buildings) {
      x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.baseLength);
      z0 = Math.min(z0, -(b.y + b.baseLength)); z1 = Math.max(z1, -b.y);
      y0 = Math.min(y0, elevation(b, 0)); y1 = Math.max(y1, elevation(b, b.floors.length));
    }
    return { x0, x1, z0, z1, y0, y1 };
  }

  frame(p: Project) {
    const B = this.bounds(p);
    const L = Math.max(B.x1 - B.x0, B.z1 - B.z0), H = B.y1 - B.y0;
    const r = Math.max(L, H) * 1.4;
    const cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2;
    this.camera.position.set(cx + r, B.y1 * 0.6 + r * 0.6, cz + r);
    this.controls.target.set(cx, (B.y0 + B.y1) / 3, cz);
    this.camera.near = Math.max(0.01, r / 1e4);
    this.camera.far = r * 100;
    this.camera.updateProjectionMatrix();
  }

  private frameKey = '';
  /** Rebuild the scene. All buildings are drawn; the active one is highlighted. */
  update(p: Project, activeId: string, mode: ViewMode, selected: Set<string>) {
    this.clear();
    const key = p.id + ':' + p.buildings.map(b => b.id).join(',');
    if (key !== this.frameKey) { this.frame(p); this.frameKey = key; }
    const B = this.bounds(p);
    const span = Math.max(B.x1 - B.x0, B.z1 - B.z0, 1);
    const underground = p.buildings.some(b => b.ground > 0);

    // ground plane (see-through when there are underground floors)
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 6, span * 6),
      new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 1, transparent: underground, opacity: underground ? 0.35 : 1, depthWrite: !underground, side: THREE.DoubleSide }),
    );
    g.rotation.x = -Math.PI / 2;
    g.position.set((B.x0 + B.x1) / 2, -0.0005 * span, (B.z0 + B.z1) / 2);
    this.content.add(g);

    for (const b of p.buildings) this.addBuilding(p, b, b.id === activeId, mode, selected);
  }

  private addBuilding(p: Project, b: Building, active: boolean, mode: ViewMode, selected: Set<string>) {
    const L = b.baseLength, N = b.floors.length;
    const yTop = elevation(b, N), yBot = elevation(b, 0);
    const white = new THREE.LineBasicMaterial({ color: active ? 0xffffff : 0x9a9a9a, transparent: true, opacity: active ? 0.55 : 0.3 });
    const under = new THREE.LineBasicMaterial({ color: 0x8fb0ff, transparent: true, opacity: active ? 0.5 : 0.25 });
    const yellow = new THREE.LineBasicMaterial({ color: 0xffd400 });
    const corners: V2[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const sq = (y: number, mat: THREE.LineBasicMaterial) => {
      this.content.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners.map(c => toWorld(b, c, y))), mat));
    };
    // building area: square at every floor level and at the top, plus vertical edges
    for (let i = 0; i <= N; i++) {
      const sel = (i < N && active && selected.has(b.floors[i].id)) || (i > 0 && active && selected.has(b.floors[i - 1].id));
      sq(elevation(b, i), sel ? yellow : i < b.ground ? under : white);
    }
    this.content.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(
      corners.flatMap(c => [toWorld(b, c, yBot), toWorld(b, c, yTop)])), white));

    if (mode === 'plan') {
      // stacked 2D plans (levels 0..N, N = Top)
      for (let k = 0; k <= N; k++) {
        const plan = planAtLevel(b, k);
        if (!plan) continue;
        const yy = elevation(b, k) + 0.002 * L;
        const isSel = active && k < N && selected.has(b.floors[k].id);
        const color = isSel ? 0xffd400 : !active ? 0x667788 : k === N ? 0xffa060 : 0x7fc8ff;
        for (const s of plan.segments) {
          const pts = sampleSeg(plan, s).map(v => toWorld(b, v, yy));
          const kind = segKind(s);
          const mat = kind === 'wall'
            ? new THREE.LineBasicMaterial({ color })
            : new THREE.LineDashedMaterial({ color, dashSize: kind === 'colonnade' ? L / 200 : L / 50, gapSize: L / 120 });
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
          if (kind !== 'wall') line.computeLineDistances();
          this.content.add(line);
        }
        for (const face of enclosedFaces(plan)) {
          const shape = new THREE.Shape(face.map(v => new THREE.Vector2(v.x * L, v.y * L)));
          const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({
            color: 0x3a7bd5, transparent: true, opacity: active ? 0.18 : 0.08, side: THREE.DoubleSide, depthWrite: false,
          }));
          m.rotation.x = -Math.PI / 2;
          m.position.set(b.x, yy, -b.y);
          this.content.add(m);
        }
      }
      return;
    }

    const detailed = mode === 'detailed';
    this.content.add(buildStructure(b, p.textures, detailed, {
      wall: new THREE.MeshStandardMaterial({ color: detailed ? 0xd8d2c4 : 0xbdbdbd, roughness: 0.9 }),
      column: new THREE.MeshStandardMaterial({ color: detailed ? 0xe6e1d6 : 0xc8c8c8, roughness: 0.8 }),
      slab: new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1 }),
      edge: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: detailed ? 0.25 : active ? 0.6 : 0.3 }),
      tex: id => this.texMat(p, id),
    }));
  }

  private texCache = new Map<string, THREE.Texture>();
  private texMat(p: Project, id: string): THREE.Material | null {
    const t = p.textures.find(x => x.id === id);
    if (!t) return null;
    let tex = this.texCache.get(id);
    if (!tex) {
      tex = new THREE.TextureLoader().load(t.data, () => this.onTexture?.());
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.texCache.set(id, tex);
    }
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
  }
  onTexture?: () => void;
}
