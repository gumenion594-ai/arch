// Three.js 3D view: ground, building-area wireframe, walls, slabs; click to pick.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Building, DecoDesign, Design, MATERIALS, Texture, elevation, segConnect, segKind } from './model';
import { designObject } from './assets';
import { decoObject } from './deco';
import { enclosedFaces, sampleSeg, V2 } from './geometry';
import { BuildStats, Mats, PickInfo, Selection, buildStructure, emptySelection, interiorForFloor, loftPointTarget, planAtLevel, toWorld } from './build3d';

export type ViewMode = 'plan' | 'structural' | 'detailed';

export interface Scene3D { id: string; buildings: Building[]; textures: Texture[]; designs?: Design[]; decos?: DecoDesign[] }
export interface ViewOpts {
  activeId: string | null; // building drawn bright ('*' or null = all)
  mode: ViewMode;
  selection?: Selection;
  showArea: boolean;
  upTo?: number | null; // cutaway: show floors up to this index (without its ceiling)
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
  /** Right-drag box: what is visible inside it. */
  onBoxPick?: (hits: Hit[], e: MouseEvent) => void;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x232323);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    (window as unknown as { __archViewer?: Viewer }).__archViewer = this; // for automated checks
    // right button: selection box; middle button pans (the wheel zooms)
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null as unknown as THREE.MOUSE };
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
    el.addEventListener('pointerdown', e => {
      down = { x: e.clientX, y: e.clientY };
      if (e.button === 2 && !this.walk && this.onBoxPick) this.startBox(e);
    });
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerup', e => {
      if (e.button === 0 && down && !this.walk && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.onPick?.(this.pick(e), e);
      down = null;
    });
    let last = performance.now();
    const loop = () => {
      if (this.disposed) return;
      const now = performance.now(), dt = (now - last) / 1000;
      last = now;
      if (this.walk) {
        // small fixed steps keep walking speed and collisions right at any frame rate
        let left = Math.min(0.25, dt);
        while (left > 1e-4 && this.walk) { const st = Math.min(0.02, left); this.walkStep(st); left -= st; }
      } else this.controls.update();
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
    this.exitWalk();
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

  // ---- selection box (right-drag) ----
  private startBox(e: PointerEvent) {
    const host = this.renderer.domElement.parentElement!, r = host.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'sel-box';
    host.appendChild(box);
    const x0 = e.clientX, y0 = e.clientY;
    const place = (x: number, y: number) => Object.assign(box.style, {
      left: `${Math.min(x0, x) - r.left}px`, top: `${Math.min(y0, y) - r.top}px`, width: `${Math.abs(x - x0)}px`, height: `${Math.abs(y - y0)}px`,
    });
    place(x0, y0);
    const move = (ev: PointerEvent) => place(ev.clientX, ev.clientY);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      box.remove();
      const w = Math.abs(ev.clientX - x0), hh = Math.abs(ev.clientY - y0);
      if (w < 4 && hh < 4) return;
      // what is visible inside: rays through a grid of points in the box
      const step = Math.max(6, Math.sqrt((w * hh) / 900));
      const hits: Hit[] = [], seen = new Set<string>();
      for (let y = Math.min(y0, ev.clientY) + step / 2; y < Math.max(y0, ev.clientY); y += step) {
        for (let x = Math.min(x0, ev.clientX) + step / 2; x < Math.max(x0, ev.clientX); x += step) {
          const hit = this.pickAt(x, y);
          if (!hit) continue;
          const key = `${hit.floorId}|${hit.segId ?? ''}|${hit.placementId ?? ''}|${Math.round(hit.point.x * 4)},${Math.round(hit.point.y * 4)},${Math.round(hit.point.z * 4)}`;
          if (!seen.has(key)) { seen.add(key); hits.push(hit); }
        }
      }
      this.onBoxPick?.(hits, ev);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  pick(e: MouseEvent): Hit | null { return this.pickAt(e.clientX, e.clientY); }
  pickAt(cx: number, cy: number): Hit | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.camera);
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
  private lastOpts: ViewOpts | null = null;
  update(s: Scene3D, o: ViewOpts) {
    this.clear();
    this.last = s;
    this.lastOpts = o;
    if (this.walk) o = { ...o, showArea: false, selection: undefined }; // at eye level the area box is just clutter
    // first person: green grass and a blue sky (no shadows); the editing views keep the dark background
    (this.scene.background as THREE.Color).set(this.walk ? 0x8ec5ee : 0x232323);
    const key = s.id + ':' + s.buildings.map(b => b.id + b.x + ',' + b.y).join(';');
    if (key !== this.frameKey) { this.frame(s); this.frameKey = key; }
    const B = this.bounds(s);
    const span = Math.max(B.x1 - B.x0, B.z1 - B.z0, 1);
    const underground = s.buildings.some(b => b.ground > 0);

    // ground plane (see-through when there are underground floors)
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(this.walk ? Math.max(span * 6, 3000) : span * 6, this.walk ? Math.max(span * 6, 3000) : span * 6), // walking: grass to the horizon
      new THREE.MeshStandardMaterial({ color: this.walk ? 0x5f8f3e : 0x6a6a6a, roughness: 1, transparent: underground, opacity: underground ? 0.35 : 1, depthWrite: !underground, side: THREE.DoubleSide }),
    );
    g.rotation.x = -Math.PI / 2;
    g.userData.ground = true;
    g.position.set((B.x0 + B.x1) / 2, -0.0005 * span, (B.z0 + B.z1) / 2);
    this.content.add(g);

    this.stats = { windowCount: 0, windowArea: 0, windowSkipped: 0 };
    for (const b of s.buildings) this.addBuilding(s, b, !o.activeId || o.activeId === '*' || b.id === o.activeId, o);
    // first person: no drawing lines (edges, division lines, floor lines), just the building
    if (this.walk) this.content.traverse(x => { if ((x as THREE.Line).isLine) x.visible = false; });
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
        // a design (imported models arranged around a shape), or a single imported model (older projects)
        const deco = id ? s.decos?.find(x => x.id === id) : undefined;
        if (deco) return decoObject(deco, b, s.designs ?? [], () => this.onTexture?.());
        const d = id ? s.designs?.find(x => x.id === id) : undefined;
        const obj = d ? designObject(d, () => this.onTexture?.()) : null;
        if (obj && d) { obj.userData.baseFracOverride = d.baseFrac ?? undefined; obj.userData.topFracOverride = d.topFrac ?? undefined; }
        return obj;
      },
      slab: new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1, side: THREE.DoubleSide }),
      object: new THREE.MeshStandardMaterial({ color: 0xa8b4c0, roughness: 0.8 }),
      edge: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: detailed ? 0.25 : active ? 0.6 : 0.3 }),
      selected: new THREE.MeshStandardMaterial({ color: 0xffd400, emissive: 0x6b5800, roughness: 0.8, side: THREE.DoubleSide }),
      selLine: new THREE.LineBasicMaterial({ color: 0xffd400 }),
      tex: id => this.texMat(s, id),
    };
    const { group, stats } = buildStructure(b, { detailed, interior: detailed, mats, selection: sel, textures: s.textures, upTo: active ? o.upTo : null });
    this.stats.windowCount += stats.windowCount; this.stats.windowArea += stats.windowArea; this.stats.windowSkipped += stats.windowSkipped;
    grp.add(group);
  }

  // ---------------------------------------------------------------- walk mode (first person)
  static readonly EYE = 1.6; // eye height above what you stand on, m
  walk: {
    x: number; z: number; feet: number; vy: number; yaw: number; pitch: number;
    fly: boolean; onGround: boolean; keys: Set<string>; drag: boolean; hud: HTMLElement;
    saved: { pos: THREE.Vector3; target: THREE.Vector3; fov: number; near: number };
  } | null = null;
  onWalkChange?: (walking: boolean) => void;

  /** Start walking in front of the building (south side), on the ground, facing it. */
  enterWalk() {
    if (this.walk || !this.last) return;
    const B = this.bounds(this.last);
    const hud = document.createElement('div');
    hud.className = 'walk-hud';
    this.host.appendChild(hud);
    this.walk = {
      x: 0, z: 0, feet: 0, vy: 0, yaw: 0, pitch: 0.05,
      fly: false, onGround: false, keys: new Set(), drag: false, hud,
      saved: { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov, near: this.camera.near },
    };
    // start 6 m in front of what is actually built (not the building area), centred on it, facing it
    const built = new THREE.Box3();
    this.content.traverse(o => { if ((o as THREE.Mesh).isMesh && !o.userData.ground) built.expandByObject(o); });
    const front = built.isEmpty() ? { x: (B.x0 + B.x1) / 2, z: B.z1 } : { x: (built.min.x + built.max.x) / 2, z: built.max.z };
    this.walk.x = front.x; this.walk.z = front.z + 6;
    this.walk.feet = this.groundBelow(this.walk.x, this.walk.z, 50) ?? 0;
    this.controls.enabled = false;
    this.camera.fov = 70; this.camera.near = 0.05; this.camera.updateProjectionMatrix();
    window.addEventListener('keydown', this.walkKey);
    window.addEventListener('keyup', this.walkKey);
    window.addEventListener('mousemove', this.walkMouse);
    this.renderer.domElement.addEventListener('mousedown', this.walkDown);
    window.addEventListener('mouseup', this.walkUp);
    this.updateHud();
    if (this.last && this.lastOpts) this.update(this.last, this.lastOpts);
    this.onWalkChange?.(true);
  }
  exitWalk() {
    const w = this.walk;
    if (!w) return;
    this.walk = null;
    w.hud.remove();
    window.removeEventListener('keydown', this.walkKey);
    window.removeEventListener('keyup', this.walkKey);
    window.removeEventListener('mousemove', this.walkMouse);
    this.renderer.domElement.removeEventListener('mousedown', this.walkDown);
    window.removeEventListener('mouseup', this.walkUp);
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
    this.camera.fov = w.saved.fov; this.camera.near = w.saved.near; this.camera.updateProjectionMatrix();
    this.camera.position.copy(w.saved.pos); this.controls.target.copy(w.saved.target);
    this.controls.enabled = true;
    this.controls.update();
    if (this.last && this.lastOpts && !this.disposed) this.update(this.last, this.lastOpts);
    this.onWalkChange?.(false);
  }
  private walkKey = (e: KeyboardEvent) => {
    const w = this.walk;
    if (!w) return;
    const t = (e.target as HTMLElement).tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    const k = e.code;
    if (e.type === 'keydown') {
      if (k === 'Escape') { e.preventDefault(); this.exitWalk(); return; }
      if (k === 'KeyF' && !e.repeat) { w.fly = !w.fly; w.vy = 0; this.updateHud(); }
      if (k === 'Space' && !w.fly && w.onGround) w.vy = 4.2; // jump
      w.keys.add(k);
    } else w.keys.delete(k);
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
    e.stopPropagation();
  };
  private walkDown = () => {
    const el = this.renderer.domElement;
    // capture the mouse like a game; where the browser refuses, dragging looks around instead
    try { const r = el.requestPointerLock?.() as unknown; if (r instanceof Promise) r.catch(() => {}); } catch { /* not allowed here */ }
    if (this.walk) this.walk.drag = true;
  };
  private walkUp = () => { if (this.walk) this.walk.drag = false; };
  private walkMouse = (e: MouseEvent) => {
    const w = this.walk;
    if (!w) return;
    const locked = document.pointerLockElement === this.renderer.domElement;
    if (!locked && !w.drag) return;
    if (Math.abs(e.movementX) > 150 || Math.abs(e.movementY) > 150) return; // browsers sometimes report a bogus jump
    w.yaw -= e.movementX * 0.0025;
    w.pitch = Math.max(-1.45, Math.min(1.45, w.pitch - e.movementY * 0.0025));
  };
  private updateHud() {
    const w = this.walk;
    if (!w) return;
    w.hud.innerHTML = `<b>${w.fly ? 'Flying' : 'Walking'}</b> · eyes ${Viewer.EYE} m above ${w.fly ? 'your feet' : 'the floor'} · ${w.feet.toFixed(1)} m elevation<br>`
      + `WASD / arrows move · mouse looks (click the view to capture it, or drag) · Shift run · `
      + (w.fly ? 'Space / E up · C / Q down · through walls' : 'Space jump') + ' · F fly · Esc exit';
  }
  /** Solid things you can stand on or bump into (not lines, not the invisible click surfaces). */
  private solids(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    this.content.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat) ? mat.every(x => !x.visible) : !mat.visible) return;
      out.push(m);
    });
    return out;
  }
  private ray = new THREE.Raycaster();
  /** Height of the first surface below (x, fromY, z), or null. */
  private groundBelow(x: number, z: number, fromY: number, objs = this.solids()): number | null {
    this.ray.set(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0));
    this.ray.far = fromY + 1000;
    const hit = this.ray.intersectObjects(objs, false)[0];
    return hit ? hit.point.y : null;
  }
  /** Can we move from (x, z) by (dx, dz) without walking into something (checked at knee and chest height)? */
  private pathClear(x: number, z: number, dx: number, dz: number, feet: number, objs: THREE.Object3D[]): boolean {
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) return true;
    const dir = new THREE.Vector3(dx / len, 0, dz / len);
    for (const hgt of [0.55, 1.0, 1.5]) { // above stair steps (you step up those), below and through the body
      this.ray.set(new THREE.Vector3(x, feet + hgt, z), dir);
      this.ray.far = len + 0.25; // keep 25 cm from walls
      if (this.ray.intersectObjects(objs, false).length) return false;
    }
    return true;
  }
  private walkStep(dt: number) {
    const w = this.walk!;
    const k = w.keys, on = (...c: string[]) => c.some(x => k.has(x));
    const objs = this.solids();
    const run = on('ShiftLeft', 'ShiftRight');
    const speed = (w.fly ? 9 : 2.8) * (run ? 2.6 : 1);
    const fwd = (on('KeyW', 'ArrowUp') ? 1 : 0) - (on('KeyS', 'ArrowDown') ? 1 : 0);
    const side = (on('KeyD', 'ArrowRight') ? 1 : 0) - (on('KeyA', 'ArrowLeft') ? 1 : 0);
    const fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw), rx = Math.cos(w.yaw), rz = -Math.sin(w.yaw);
    let dx = fx * fwd + rx * side, dz = fz * fwd + rz * side;
    const l = Math.hypot(dx, dz);
    if (l > 0) { dx = (dx / l) * speed * dt; dz = (dz / l) * speed * dt; }
    // flying: straight through walls, floors and the ground (no collisions)
    if (w.fly) { w.x += dx; w.z += dz; }
    // walking: slide along walls: try the full move, then each axis on its own
    else if (this.pathClear(w.x, w.z, dx, dz, w.feet, objs)) { w.x += dx; w.z += dz; }
    else {
      if (this.pathClear(w.x, w.z, dx, 0, w.feet, objs)) w.x += dx;
      if (this.pathClear(w.x, w.z, 0, dz, w.feet, objs)) w.z += dz;
    }
    if (w.fly) {
      const v = ((on('Space', 'KeyE') ? 1 : 0) - (on('KeyC', 'KeyQ', 'ControlLeft') ? 1 : 0)) * speed * dt;
      w.feet = Math.max(-300, Math.min(3000, w.feet + v));
      w.onGround = false;
    } else {
      // gravity; step up onto anything up to 40 cm higher (stairs), fall otherwise
      w.vy -= 9.8 * dt;
      const g = this.groundBelow(w.x, w.z, w.feet + 0.4, objs) ?? (w.feet >= -1e-3 ? 0 : null); // past the grass: still ground at 0
      const next = w.feet + w.vy * dt;
      if (g !== null && next <= g) { w.feet = g; w.vy = 0; w.onGround = true; }
      else { w.feet = next; w.onGround = false; }
      if (w.feet < -500) { w.feet = 0; w.vy = 0; } // fell off the world
    }
    this.camera.position.set(w.x, w.feet + Viewer.EYE, w.z);
    this.camera.rotation.set(w.pitch, w.yaw, 0, 'YXZ');
    if (Math.round(w.feet * 10) !== Math.round((w as any).lastHud ?? -1e9)) { (w as any).lastHud = Math.round(w.feet * 10); this.updateHud(); }
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
