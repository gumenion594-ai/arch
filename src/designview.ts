// Design editor 3D view: the reference shape (a window plane in its wall, a column, a strip of wall…) and the
// imported models of the design around it, moved / rotated / scaled with a gizmo.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { Building, DecoDesign, DecoPart, Design, MATERIALS, Texture } from './model';
import { designObject } from './assets';
import { REF_WALL, applyLook, decoRef, partObject } from './deco';
import { materialLook } from './materials';
import { BALUSTER, CORNICE } from './build3d';
import { smoothClosed } from './geometry';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export interface DesignViewHost {
  select(partId: string | null, add: boolean): void; // add: Shift-click (several parts)
  begin(): void; // before a gizmo drag (undo)
  commit(): void; // after it
  live(): void; // while dragging (update number fields)
}

const refMat = new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.95, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
const planeMat = new THREE.MeshBasicMaterial({ color: 0x4a90d9, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
const lineMat = new THREE.LineBasicMaterial({ color: 0x7fc8ff });
const boxMat = new THREE.LineDashedMaterial({ color: 0xffa060, dashSize: 0.06, gapSize: 0.05 });

export class DesignView {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.01, 500);
  orbit: OrbitControls;
  gizmo: TransformControls;
  private ref = new THREE.Group();
  private parts = new THREE.Group();
  private deco: DecoDesign | null = null;
  private framedFor = '';
  private disposed = false;
  private ro: ResizeObserver;
  selected: string | null = null;
  /** Other selected parts (Shift), outlined. */
  also = new Set<string>();
  private outlines = new THREE.Group();
  private texCache = new Map<string, THREE.Texture>();
  private textures: Texture[] = [];
  /** A part's look: texture > material > colour (null: the model's own). */
  private look(part: DecoPart): THREE.Material | null {
    if (part.texture) {
      const t = this.textures.find(x => x.id === part.texture);
      if (t) {
        let tex = this.texCache.get(t.id);
        if (!tex) { tex = new THREE.TextureLoader().load(t.data); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; this.texCache.set(t.id, tex); }
        return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide });
      }
    }
    if (part.material) return materialLook(part.material, part.color); // tinted by its colour
    if (part.color) return new THREE.MeshStandardMaterial({ color: new THREE.Color(part.color), roughness: 0.85, side: THREE.DoubleSide });
    return null;
  }
  private down: { x: number; y: number } | null = null;

  constructor(private host: HTMLElement, private h: DesignViewHost) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x232323);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(3, 5, 6); this.scene.add(sun);
    const grid = new THREE.GridHelper(10, 20, 0x555555, 0x383838); grid.position.y = -0.001; this.scene.add(grid);
    this.scene.add(this.ref, this.parts, this.outlines);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', e => {
      this.orbit.enabled = !e.value;
      if (e.value) this.h.begin(); else { this.writeBack(); this.h.commit(); }
    });
    this.gizmo.addEventListener('objectChange', () => { this.writeBack(); this.h.live(); });
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', e => (this.down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', e => {
      const d = this.down; this.down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || this.gizmo.dragging || this.gizmo.axis) return;
      this.h.select(this.pick(e), e.shiftKey || e.ctrlKey || e.metaKey);
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    const loop = () => { if (this.disposed) return; this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop); };
    loop();
  }
  dispose() {
    this.disposed = true;
    this.ro.disconnect();
    this.gizmo.detach(); this.gizmo.dispose(); this.orbit.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
  private resize() {
    const w = this.host.clientWidth, hh = this.host.clientHeight;
    if (!w || !hh) return;
    this.renderer.setSize(w, hh);
    this.camera.aspect = w / hh;
    this.camera.updateProjectionMatrix();
  }
  setMode(m: GizmoMode) { this.gizmo.setMode(m); }
  get mode(): GizmoMode { return this.gizmo.getMode() as GizmoMode; }

  /** Show a design (null: only an empty stage). Keeps the camera unless it is another design. */
  set(deco: DecoDesign | null, b: Building, models: Design[], onLoad: () => void, textures: Texture[] = []) {
    this.deco = deco;
    this.textures = textures;
    this.gizmo.detach();
    this.ref.clear(); this.parts.clear();
    if (!deco) return;
    const R = decoRef(deco, b);
    this.ref.add(referenceShape(deco, b));
    // the reference box: what gets stretched onto the real element
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(R.w, R.h, R.d)), boxMat);
    edges.computeLineDistances();
    this.ref.add(edges);
    for (const part of deco.parts) {
      const m = models.find(x => x.id === part.modelId);
      const src = m ? designObject(m, onLoad) : null;
      const g = src ? partObject(src, part) : placeholder(part);
      if (src) applyLook(g, this.look(part));
      g.userData.partId = part.id;
      this.parts.add(g);
    }
    // lift everything so the reference sits on the grid
    const lift = R.h / 2 + (deco.type === 'opening' || deco.type === 'niche' ? 0.6 : deco.type === 'cornice' ? 2.5 : 0);
    this.ref.position.y = this.parts.position.y = lift;
    const key = deco.id + ':' + deco.type;
    if (key !== this.framedFor) {
      this.framedFor = key;
      const r = Math.max(R.w, R.h, R.d, 0.5) * 1.6 + 0.6;
      this.orbit.target.set(0, lift, 0);
      this.camera.position.set(r * 0.55, lift + r * 0.35, r);
      this.orbit.update();
    }
    if (this.selected) this.select(this.selected);
  }
  select(id: string | null, also: Iterable<string> = []) {
    this.selected = id;
    this.also = new Set([...also].filter(x => x !== id));
    const g = this.parts.children.find(c => c.userData.partId === id);
    if (g) this.gizmo.attach(g); else this.gizmo.detach();
    // the other selected parts: yellow boxes
    this.outlines.clear();
    this.parts.updateMatrixWorld(true);
    this.outlines.position.copy(this.parts.position);
    for (const c of this.parts.children) {
      if (!this.also.has(c.userData.partId)) continue;
      const box = new THREE.BoxHelper(c, 0xffd400);
      box.position.sub(this.parts.position);
      this.outlines.add(box);
    }
  }
  private pick(e: PointerEvent): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = ray.intersectObjects(this.parts.children, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !o.userData.partId) o = o.parent;
    return o?.userData.partId ?? null;
  }
  /** Gizmo -> the selected part's numbers. */
  private writeBack() {
    const g = this.gizmo.object, part = this.deco?.parts.find(p => p.id === g?.userData.partId);
    if (!g || !part) return;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    part.pos = [r3(g.position.x), r3(g.position.y), r3(g.position.z)];
    part.rot = [g.rotation.x, g.rotation.y, g.rotation.z].map(a => Math.round(((a * 180) / Math.PI) * 10) / 10) as [number, number, number];
    part.size = [g.scale.x, g.scale.y, g.scale.z].map(v => r3(Math.max(0.005, Math.abs(v)))) as [number, number, number];
  }
}

/** A model that is still loading: its box. */
function placeholder(part: DecoPart) {
  const g = partObject(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x888888, wireframe: true })), part);
  return g;
}

/** The reference shape, centred like the reference box (see decoRef). */
function referenceShape(deco: DecoDesign, b: Building): THREE.Object3D {
  const R = decoRef(deco, b), g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material = refMat) => { const m = new THREE.Mesh(geo, mat); g.add(m); return m; };
  const wallBehind = (w: number, h: number, z: number, yc = 0) => add(new THREE.BoxGeometry(w, h, REF_WALL).translate(0, yc, z - REF_WALL / 2));
  switch (deco.type) {
    case 'opening': case 'niche': {
      const s = b.openingShapes.find(x => x.id === deco.shapeId);
      const outlines = (s?.outlines ?? [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]]).filter(o => o.length >= 3)
        .map(o => smoothClosed(o, s?.smooth ?? 0).map(q => new THREE.Vector2((q.x - 0.5) * R.w, (q.y - 0.5) * R.h)));
      // the wall (behind the face), with the opening cut through it
      const W2 = R.w / 2 + 1, H2 = R.h / 2 + 0.6;
      const wall = new THREE.Shape([new THREE.Vector2(-W2, -H2), new THREE.Vector2(W2, -H2), new THREE.Vector2(W2, H2), new THREE.Vector2(-W2, H2)]);
      if (deco.type === 'opening') for (const o of outlines) wall.holes.push(new THREE.Path(o));
      add(new THREE.ExtrudeGeometry(wall, { depth: REF_WALL, bevelEnabled: false }).translate(0, 0, -REF_WALL));
      // the shape: a plane on the outside face
      for (const o of outlines) {
        add(new THREE.ShapeGeometry(new THREE.Shape(o)).translate(0, 0, 0.002), planeMat);
        g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(o.map(v => new THREE.Vector3(v.x, v.y, 0.004))), lineMat));
      }
      break;
    }
    case 'balcony': {
      const s = b.balconyShapes.find(x => x.id === deco.shapeId) ?? b.balconyShapes[0];
      const pts = smoothClosed(s?.outline ?? [], s?.smooth ?? 0, 10).map(q => new THREE.Vector2((q.x - 0.5) * R.w, -(q.y - 0.5) * R.d));
      if (pts.length >= 3) add(new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: R.h, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, -R.h / 2, 0), planeMat);
      wallBehind(R.w + 2, 3, -R.d / 2, 1);
      break;
    }
    case 'pilaster': {
      // a plain rectangular column against the wall; the base and top bands keep their size on the building
      const bH = (deco.base ?? 0.12) * R.h, tH = (deco.top ?? 0.12) * R.h;
      add(new THREE.BoxGeometry(R.w, bH, R.d).translate(0, -R.h / 2 + bH / 2, 0), planeMat);
      add(new THREE.BoxGeometry(R.w * 0.9, R.h - bH - tH, R.d * 0.9).translate(0, (bH - tH) / 2, -R.d * 0.05));
      add(new THREE.BoxGeometry(R.w, tH, R.d).translate(0, R.h / 2 - tH / 2, 0), planeMat);
      wallBehind(R.w + 1.5, R.h, -R.d / 2);
      break;
    }
    case 'column': {
      // round shaft between a square base and top: the base / top bands keep their size on the building
      const bH = (deco.base ?? 0.12) * R.h, tH = (deco.top ?? 0.12) * R.h;
      add(new THREE.BoxGeometry(R.w, bH, R.d).translate(0, -R.h / 2 + bH / 2, 0), planeMat);
      add(new THREE.CylinderGeometry(R.w * 0.4, R.w * 0.42, R.h - bH - tH, 32).translate(0, (bH - tH) / 2, 0));
      add(new THREE.BoxGeometry(R.w, tH, R.d).translate(0, R.h / 2 - tH / 2, 0), planeMat);
      break;
    }
    case 'cornice': {
      // the plain cornice profile along 3 m, hanging from the top of the wall face
      const sh = new THREE.Shape(CORNICE.map(([x, y]) => new THREE.Vector2(x, -y)));
      add(new THREE.ExtrudeGeometry(sh, { depth: R.w, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(R.w / 2, R.h / 2, -R.d / 2), planeMat);
      wallBehind(R.w + 1, 2.5, -R.d / 2, R.h / 2 - 1.25);
      break;
    }
    case 'wall': add(new THREE.BoxGeometry(R.w, R.h, R.d), planeMat); break;
    case 'baluster': {
      // a 1 m section of railing: plinth, four balusters, handrail (repeated along the railing on the building)
      add(new THREE.BoxGeometry(R.w, 0.12, R.d).translate(0, -R.h / 2 + 0.06, 0), planeMat);
      add(new THREE.BoxGeometry(R.w, 0.08, R.d * 0.9).translate(0, R.h / 2 - 0.04, 0), planeMat);
      for (const x of [-0.375, -0.125, 0.125, 0.375]) add(new THREE.LatheGeometry(BALUSTER, 16).translate(x, -R.h / 2 + 0.12, 0));
      break;
    }
  }
  return g;
}
