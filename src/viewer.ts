// Three.js 3D view: ground, building-area wireframe, walls, slabs; click to pick.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Building, Design, MATERIALS, Texture, elevation, segConnect, segKind } from './model';
import { designObject } from './assets';
import { enclosedFaces, sampleSeg, V2 } from './geometry';
import { BuildStats, Mats, PickInfo, Selection, buildStructure, emptySelection, interiorForFloor, loftPointTarget, planAtLevel, toWorld } from './build3d';

export type ViewMode = 'plan' | 'structural' | 'detailed';

export interface Scene3D { id: string; buildings: Building[]; textures: Texture[]; designs?: Design[] }
export interface ViewOpts {
  activeId: string | null; // building drawn bright ('*' or null = all)
  mode: ViewMode;
  selection?: Selection;
  showArea: boolean;
}
export type Hit = PickInfo & { buildingId: string; point: THREE.Vector3 };

export class Viewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  private content = new THREE.Group();
  private ro: ResizeObserver;
  private disposed = false;
  private frameKey = '';
  stats: BuildStats = { windowCount: 0, windowArea: 0, windowSkipped: 0 };
  onPick?: (hit: Hit | null, e: MouseEvent) => void;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
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
    // a click (not a drag) picks
    let down: { x: number; y: number } | null = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', e => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', e => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.onPick?.(this.pick(e), e);
      down = null;
    });
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
    const shared = new Set(this.sharedMats);
    this.content.traverse(o => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m && !m.visible) shared.add(m); });
    this.content.traverse(o => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      const one = (x: THREE.Material) => { if (!shared.has(x)) x.dispose(); };
      if (Array.isArray(mat)) mat.forEach(one); else if (mat) one(mat);
    });
    this.content.clear();
  }
  private sharedMats: THREE.Material[] = [];

  pick(e: MouseEvent): Hit | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    for (const hit of ray.intersectObjects(this.content.children, true)) {
      const info = hit.object.userData?.pick as PickInfo | undefined;
      if (info && hit.object instanceof THREE.Mesh) {
        let o: THREE.Object3D | null = hit.object;
        while (o && !o.userData.buildingId) o = o.parent;
        return { ...info, buildingId: o?.userData.buildingId, point: hit.point };
      }
    }
    return null;
  }

  private bounds(s: Scene3D) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = 0, y1 = 0;
    for (const b of s.buildings) {
      x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.baseLength);
      z0 = Math.min(z0, -(b.y + b.baseLength)); z1 = Math.max(z1, -b.y);
      y0 = Math.min(y0, elevation(b, 0)); y1 = Math.max(y1, elevation(b, b.floors.length));
    }
    if (!s.buildings.length) return { x0: -10, x1: 10, z0: -10, z1: 10, y0: 0, y1: 10 };
    return { x0, x1, z0, z1, y0, y1 };
  }

  frame(s: Scene3D) {
    const B = this.bounds(s);
    const L = Math.max(B.x1 - B.x0, B.z1 - B.z0), H = B.y1 - B.y0;
    const r = Math.max(L, H) * 1.4;
    const cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2;
    this.camera.position.set(cx + r, B.y1 * 0.6 + r * 0.6, cz + r);
    this.controls.target.set(cx, (B.y0 + B.y1) / 3, cz);
    this.camera.near = Math.max(0.01, r / 1e4);
    this.camera.far = r * 100;
    this.camera.updateProjectionMatrix();
  }

  private last: Scene3D | null = null;
  /** Camera presets. Front looks from the south (plan y = 0 side) towards the north. */
  look(dir: 'front' | 'back' | 'left' | 'right' | 'top' | 'corner') {
    if (!this.last) return;
    const B = this.bounds(this.last);
    const cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2, cy = (B.y0 + B.y1) / 2;
    const r = Math.max(B.x1 - B.x0, B.z1 - B.z0, B.y1 - B.y0) * 1.5;
    const d: Record<string, [number, number, number]> = {
      front: [0, 0.25, 1], back: [0, 0.25, -1], left: [-1, 0.25, 0], right: [1, 0.25, 0], top: [0, 1, 0.001], corner: [0.7, 0.5, 0.7],
    };
    const [x, y, z] = d[dir];
    const v = new THREE.Vector3(x, y, z).normalize().multiplyScalar(r);
    this.controls.target.set(cx, cy * 0.8, cz);
    this.camera.position.set(cx + v.x, cy * 0.8 + v.y, cz + v.z);
    this.controls.update();
  }

  /** Rebuild the scene. */
  update(s: Scene3D, o: ViewOpts) {
    this.clear();
    this.last = s;
    const key = s.id + ':' + s.buildings.map(b => b.id + b.x + ',' + b.y).join(';');
    if (key !== this.frameKey) { this.frame(s); this.frameKey = key; }
    const B = this.bounds(s);
    const span = Math.max(B.x1 - B.x0, B.z1 - B.z0, 1);
    const underground = s.buildings.some(b => b.ground > 0);

    // ground plane (see-through when there are underground floors)
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 6, span * 6),
      new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 1, transparent: underground, opacity: underground ? 0.35 : 1, depthWrite: !underground, side: THREE.DoubleSide }),
    );
    g.rotation.x = -Math.PI / 2;
    g.position.set((B.x0 + B.x1) / 2, -0.0005 * span, (B.z0 + B.z1) / 2);
    this.content.add(g);

    this.stats = { windowCount: 0, windowArea: 0, windowSkipped: 0 };
    for (const b of s.buildings) this.addBuilding(s, b, !o.activeId || o.activeId === '*' || b.id === o.activeId, o);
  }

  private addBuilding(s: Scene3D, b: Building, active: boolean, o: ViewOpts) {
    const L = b.baseLength, N = b.floors.length;
    const grp = new THREE.Group();
    grp.userData.buildingId = b.id;
    this.content.add(grp);
    const sel = active ? o.selection ?? emptySelection() : emptySelection();
    const floorSel = (i: number) => i >= 0 && i < N && sel.floors.has(b.floors[i].id);

    if (o.showArea) {
      const white = new THREE.LineBasicMaterial({ color: active ? 0xffffff : 0x9a9a9a, transparent: true, opacity: active ? 0.55 : 0.3 });
      const under = new THREE.LineBasicMaterial({ color: 0x8fb0ff, transparent: true, opacity: active ? 0.5 : 0.25 });
      const yellow = new THREE.LineBasicMaterial({ color: 0xffd400 });
      const corners: V2[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
      for (let i = 0; i <= N; i++) {
        grp.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners.map(c => toWorld(b, c, elevation(b, i)))),
          floorSel(i) || floorSel(i - 1) ? yellow : i < b.ground ? under : white));
      }
      grp.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(
        corners.flatMap(c => [toWorld(b, c, elevation(b, 0)), toWorld(b, c, elevation(b, N))])), white));
    }

    if (o.mode === 'plan') {
      // stacked 2D plans (levels 0..N, N = Top), floor plans drawn in green
      for (let k = 0; k <= N; k++) {
        const yy = elevation(b, k) + 0.002 * L;
        const isSel = floorSel(k);
        const layers: [ReturnType<typeof planAtLevel>, number][] = [[planAtLevel(b, k), isSel ? 0xffd400 : !active ? 0x667788 : k === N ? 0xffa060 : 0x7fc8ff]];
        if (k < N) layers.push([interiorForFloor(b, b.floors[k].id), isSel ? 0xffe680 : 0x8fd88f]);
        for (const [plan, color] of layers) {
          if (!plan) continue;
          for (const sg of plan.segments) {
            const pts = sampleSeg(plan, sg).map(v => toWorld(b, v, yy));
            const kind = segKind(sg);
            const mat = kind === 'wall'
              ? new THREE.LineBasicMaterial({ color })
              : new THREE.LineDashedMaterial({ color, dashSize: kind === 'colonnade' ? L / 200 : L / 50, gapSize: L / 120 });
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
            if (kind !== 'wall') line.computeLineDistances();
            grp.add(line);
          }
          if (color === 0x8fd88f || color === 0xffe680) continue; // no fill for floor plans
          // walls that connect to the plan above: join each point to the point it connects to
          const above = k < N ? planAtLevel(b, k + 1) : null;
          if (above && above.points.length) {
            const ends = new Set(plan.segments.filter(sg => segConnect(plan, sg) === 'loft' && segKind(sg) !== 'open').flatMap(sg => [sg.a, sg.b]));
            const pts: THREE.Vector3[] = [];
            for (const pt of plan.points) {
              if (!ends.has(pt.id)) continue;
              pts.push(toWorld(b, pt, yy), toWorld(b, loftPointTarget(plan, above, pt), elevation(b, k + 1) + 0.002 * L));
            }
            if (pts.length) {
              const ln = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
                new THREE.LineDashedMaterial({ color: active ? 0xffb070 : 0x887766, dashSize: L / 80, gapSize: L / 160 }));
              ln.computeLineDistances();
              grp.add(ln);
            }
          }
          for (const face of enclosedFaces(plan)) {
            const shape = new THREE.Shape(face.map(v => new THREE.Vector2(v.x * L, v.y * L)));
            const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({
              color: 0x3a7bd5, transparent: true, opacity: active ? 0.18 : 0.08, side: THREE.DoubleSide, depthWrite: false,
            }));
            m.rotation.x = -Math.PI / 2;
            m.position.set(b.x, yy, -b.y);
            if (k < N) m.userData.pick = { floorId: b.floors[k].id, floorIndex: k } as PickInfo;
            grp.add(m);
          }
        }
      }
      return;
    }

    const detailed = o.mode === 'detailed';
    const matCache = new Map<string, THREE.Material>();
    const std = (key: string, make: () => THREE.Material) => matCache.get(key) ?? matCache.set(key, make()).get(key)!;
    const mats: Mats = {
      wall: m => std('w' + m, () => new THREE.MeshStandardMaterial({
        color: m === 'structural' ? 0xbdbdbd : MATERIALS[m]?.color ?? 0xd8d2c4, roughness: 0.9, side: THREE.DoubleSide,
        transparent: m === 'glass', opacity: m === 'glass' ? 0.45 : 1,
      })),
      column: m => std('c' + m, () => new THREE.MeshStandardMaterial({ color: detailed ? MATERIALS[m]?.color ?? 0xe6e1d6 : 0xc8c8c8, roughness: 0.8, side: THREE.DoubleSide })),
      color: css => std('k' + css, () => new THREE.MeshStandardMaterial({ color: new THREE.Color(css), roughness: 0.85, side: THREE.DoubleSide })),
      deco: new THREE.MeshStandardMaterial({ color: detailed ? 0xeee8dc : 0xd0d0d0, roughness: 0.75, side: THREE.DoubleSide }),
      design: id => {
        const d = id ? s.designs?.find(x => x.id === id) : undefined;
        return d ? designObject(d, () => this.onTexture?.()) : null;
      },
      slab: new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1, side: THREE.DoubleSide }),
      object: new THREE.MeshStandardMaterial({ color: 0xa8b4c0, roughness: 0.8 }),
      edge: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: detailed ? 0.25 : active ? 0.6 : 0.3 }),
      selected: new THREE.MeshStandardMaterial({ color: 0xffd400, emissive: 0x6b5800, roughness: 0.8, side: THREE.DoubleSide }),
      selLine: new THREE.LineBasicMaterial({ color: 0xffd400 }),
      tex: id => this.texMat(s, id),
    };
    const { group, stats } = buildStructure(b, { detailed, interior: detailed, mats, selection: sel, textures: s.textures });
    this.stats.windowCount += stats.windowCount; this.stats.windowArea += stats.windowArea; this.stats.windowSkipped += stats.windowSkipped;
    grp.add(group);
  }

  private texCache = new Map<string, THREE.Texture>();
  private texMat(s: Scene3D, id: string): THREE.Material | null {
    const t = s.textures.find(x => x.id === id);
    if (!t) return null;
    let tex = this.texCache.get(id);
    if (!tex) {
      tex = new THREE.TextureLoader().load(t.data, () => this.onTexture?.());
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.texCache.set(id, tex);
    }
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide });
  }
  onTexture?: () => void;
}
