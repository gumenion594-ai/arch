// Three.js 3D view: ground, building-area wireframe, floor lines, walls and slabs.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Project, floorBase, segKind, totalHeight } from './model';
import { enclosedFaces, sampleSeg, V2 } from './geometry';
import { buildStructure, planAtLevel } from './build3d';

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
  update(p: Project, mode: ViewMode, selected: Set<string>) {
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
      sq(y, selected.has(f.id) ? yellow : white);
      y += f.height;
    });
    sq(H, white);
    p.floors.forEach((f, i) => { if (selected.has(f.id)) sq(floorBase(p, i + 1), yellow); });
    const vgeo = new THREE.BufferGeometry().setFromPoints(
      [[0, 0], [L, 0], [L, L], [0, L]].flatMap(([x, z]) => [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, H, z)]),
    );
    this.content.add(new THREE.LineSegments(vgeo, white));

    const toW = (v: V2, yy: number) => new THREE.Vector3(v.x * L, yy, (1 - v.y) * L);

    if (mode === 'plan') {
      // stacked 2D plans (levels 0..N, N = Top)
      for (let k = 0; k <= p.floors.length; k++) {
        const plan = planAtLevel(p, k);
        if (!plan) continue;
        const yy = (k < p.floors.length ? floorBase(p, k) : H) + 0.002 * L;
        const isSel = k < p.floors.length && selected.has(p.floors[k].id);
        const color = isSel ? 0xffd400 : k === p.floors.length ? 0xffa060 : 0x7fc8ff;
        for (const s of plan.segments) {
          const pts = sampleSeg(plan, s).map(v => toW(v, yy));
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
            color: 0x3a7bd5, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false,
          }));
          m.rotation.x = -Math.PI / 2;
          m.position.set(0, yy, L);
          this.content.add(m);
        }
      }
      return;
    }

    const detailed = mode === 'detailed';
    this.content.add(buildStructure(p, detailed, {
      wall: new THREE.MeshStandardMaterial({ color: detailed ? 0xd8d2c4 : 0xbdbdbd, roughness: 0.9 }),
      column: new THREE.MeshStandardMaterial({ color: detailed ? 0xe6e1d6 : 0xc8c8c8, roughness: 0.8 }),
      slab: new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1 }),
      edge: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: detailed ? 0.25 : 0.6 }),
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
