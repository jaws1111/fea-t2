import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { resolveWorkingBounds } from '../scene/workingVolume.js';

/** Thinnest box the user can drag to (normalized). */
const MIN_SIZE = 0.02;
/** How far past the current domain a corner may be pulled (normalized). */
const LIMIT_LO = -2;
const LIMIT_HI = 3;

const KEYS = ['x', 'y', 'z'];

/**
 * Draggable corner handles for the working volume (Scene tab).
 *
 * Selecting a corner shows a translate gizmo; dragging it moves the three box sides that meet
 * there. The box may leave the current domain (the domain is re-fitted on release). It can never
 * exclude the anchor point of a scene object. On release `onCommit(bounds)` receives the new
 * box in normalized coordinates of the CURRENT domain (values may lie outside [0,1]).
 *
 * @param {{
 *   scene: THREE.Scene,
 *   camera: THREE.Camera,
 *   domElement: HTMLElement,
 *   controls?: { enabled: boolean } | null,
 *   getConfig: () => { nx: number, ny: number, nz: number, scene?: import('../scene/types.js').Scene | null },
 *   onPreview?: (bounds: object | null) => void,
 *   onCommit?: (bounds: object) => void,
 *   onSelect?: () => void,
 * }} opts
 */
export function createVolumeGizmo({ scene, camera, domElement, controls, getConfig, onPreview, onCommit, onSelect }) {
  const group = new THREE.Group();
  group.name = 'working-volume-handles';
  group.visible = false;
  scene.add(group);

  const tc = new TransformControls(camera, domElement);
  tc.setMode('translate');
  tc.setSize(0.8);
  tc.enabled = false;
  const helper = tc.getHelper();
  helper.visible = false;
  scene.add(helper);

  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xa5b4fc,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
  const matSel = mat.clone();
  matSel.color.set(0xfde047);

  const camPos = new THREE.Vector3();
  /** @type {THREE.Mesh[]} index bit0 = x high, bit1 = y high, bit2 = z high */
  const corners = [];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(geom, mat);
    m.name = `wv-corner-${i}`;
    m.renderOrder = 1001;
    m.userData.corner = i;
    m.onBeforeRender = (_r, _s, cam) => {
      m.getWorldPosition(camPos);
      const s = THREE.MathUtils.clamp(camPos.distanceTo(cam.position) * 0.016, 0.5, 4);
      if (Math.abs(m.scale.x - s) > 1e-3) {
        m.scale.setScalar(s);
        m.updateMatrixWorld();
      }
    };
    group.add(m);
    corners.push(m);
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let enabled = false;
  let dragging = false;
  let selected = -1;
  let downX = 0;
  let downY = 0;
  let downHit = false;
  /** Box being dragged (normalized, current-domain coords), null when idle. */
  let cur = null;

  const dims = () => {
    const c = getConfig();
    return { nx: c.nx, ny: c.ny, nz: c.nz };
  };
  const nOf = (d) => ({ x: d.nx, y: d.ny, z: d.nz });

  /** Box shown when idle: the effective working volume. */
  function idleBounds() {
    const c = getConfig();
    return { ...resolveWorkingBounds(c.scene ?? null, dims()) };
  }

  /** Per-axis [min, max] of scene object anchors (normalized), for the containment rule. */
  function anchorRange() {
    const sc = getConfig().scene;
    const r = {
      x: [Infinity, -Infinity],
      y: [Infinity, -Infinity],
      z: [Infinity, -Infinity],
    };
    if (!sc) return r;
    for (const f of sc.components ?? []) {
      if (!f) continue;
      const faceAxis = f.type === 'wall_pad' ? String(f.face ?? 'x-')[0] : null;
      for (const k of KEYS) {
        if (k === faceAxis || !Number.isFinite(f[k])) continue;
        r[k][0] = Math.min(r[k][0], f[k]);
        r[k][1] = Math.max(r[k][1], f[k]);
      }
    }
    return r;
  }

  function placeCorners(b) {
    const d = dims();
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? b.x1 : b.x0;
      const y = i & 2 ? b.y1 : b.y0;
      const z = i & 4 ? b.z1 : b.z0;
      corners[i].position.set(x * d.nx - d.nx / 2, y * d.ny - d.ny / 2, z * d.nz - d.nz / 2);
    }
    group.updateMatrixWorld(true);
  }

  /** Re-place the handles on the effective working volume (call after scene / grid changes). */
  function sync() {
    if (dragging) return;
    placeCorners(idleBounds());
    if (selected >= 0 && enabled) {
      tc.attach(corners[selected]);
    }
  }

  function setSelected(i) {
    selected = i;
    for (let k = 0; k < 8; k++) corners[k].material = k === i ? matSel : mat;
    if (i < 0) {
      tc.detach();
      helper.visible = false;
    } else {
      tc.attach(corners[i]);
      helper.visible = true;
    }
  }

  function deselect() {
    if (selected >= 0) setSelected(-1);
  }

  function pick(ev) {
    const rect = domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(corners, false);
    return hits.length ? hits[0].object.userData.corner : -1;
  }

  function onPointerDown(ev) {
    if (!enabled || ev.button !== 0) return;
    downX = ev.clientX;
    downY = ev.clientY;
    downHit = false;
    if (tc.object && tc.axis) {
      controls && (controls.enabled = false);
      downHit = true;
      return;
    }
    const i = pick(ev);
    if (i >= 0) {
      downHit = true;
      setSelected(i);
      onSelect?.();
    }
  }

  function onPointerUp(ev) {
    if (!enabled || ev.button !== 0 || dragging) return;
    const moved = Math.hypot(ev.clientX - downX, ev.clientY - downY);
    if (!downHit && moved < 4 && selected >= 0) deselect();
    if (controls && !dragging) controls.enabled = true;
  }

  tc.addEventListener('dragging-changed', (e) => {
    dragging = !!e.value;
    if (controls) controls.enabled = !dragging;
  });

  tc.addEventListener('objectChange', () => {
    const proxy = tc.object;
    if (!proxy || selected < 0) return;
    const d = dims();
    const n = nOf(d);
    if (!cur) cur = idleBounds();
    const anchors = anchorRange();
    const high = [selected & 1, selected & 2, selected & 4];
    KEYS.forEach((k, a) => {
      const w = proxy.position[k];
      let v = (w + n[k] / 2) / n[k];
      v = Math.min(LIMIT_HI, Math.max(LIMIT_LO, v));
      const lo = `${k}0`;
      const hi = `${k}1`;
      if (high[a]) {
        v = Math.max(v, cur[lo] + MIN_SIZE);
        if (Number.isFinite(anchors[k][1])) v = Math.max(v, anchors[k][1]);
        cur[hi] = v;
      } else {
        v = Math.min(v, cur[hi] - MIN_SIZE);
        if (Number.isFinite(anchors[k][0])) v = Math.min(v, anchors[k][0]);
        cur[lo] = v;
      }
    });
    // Write the constrained corner back so the handle can't leave the allowed range.
    placeCorners(cur);
    onPreview?.({ ...cur });
  });

  tc.addEventListener('mouseUp', () => {
    dragging = false;
    if (controls) controls.enabled = true;
    const done = cur;
    cur = null;
    if (done) {
      onPreview?.(null);
      onCommit?.({ ...done });
    }
  });

  domElement.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerUp);

  function setEnabled(on) {
    enabled = !!on;
    tc.enabled = enabled;
    group.visible = enabled;
    if (!enabled) {
      deselect();
      dragging = false;
      cur = null;
      if (controls) controls.enabled = true;
    } else {
      placeCorners(idleBounds());
    }
  }

  function dispose() {
    domElement.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointerup', onPointerUp);
    tc.detach();
    tc.dispose();
    scene.remove(helper);
    scene.remove(group);
    geom.dispose();
    mat.dispose();
    matSel.dispose();
    if (controls) controls.enabled = true;
  }

  return { sync, setEnabled, deselect, dispose };
}
