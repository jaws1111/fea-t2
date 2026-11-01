import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { nodeToWorld } from './coordinates.js';
import { componentDef } from '../scene/components/index.js';
import { applyLinksAfterMove, ensureLinks, findComponent } from '../scene/links.js';

/** Colours match boundaryFixtures.js glyphs. */
const COLORS = {
  rest_point: 0x10b981,
  wall_pad: 0x10b981,
  bolt_hole: 0xf59e0b,
  force: 0xef4444,
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampInt = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Normalized (0..1) → world position, snapped to grid nodes exactly like the solver
 * (ix = round(x * nx)).
 * @param {{ nx: number, ny: number, nz: number }} config
 * @returns {{ x: number, y: number, z: number }}
 */
export function normToWorld(config, x, y, z) {
  const ix = clampInt(Math.round((Number.isFinite(x) ? x : 0) * config.nx), 0, config.nx);
  const iy = clampInt(Math.round((Number.isFinite(y) ? y : 0) * config.ny), 0, config.ny);
  const iz = clampInt(Math.round((Number.isFinite(z) ? z : 0) * config.nz), 0, config.nz);
  return nodeToWorld(config, ix, iy, iz);
}

/**
 * World position → normalized coords clamped to [0,1] (continuous, not snapped).
 * @param {{ nx: number, ny: number, nz: number }} config
 * @returns {{ x: number, y: number, z: number }}
 */
export function worldToNorm(config, wx, wy, wz) {
  return {
    x: clamp01((wx + config.nx / 2) / config.nx),
    y: clamp01((wy + config.ny / 2) / config.ny),
    z: clamp01((wz + config.nz / 2) / config.nz),
  };
}

/** Face-normal axis index and coordinate (0 or 1) of a wall pad, e.g. 'x-' → ['x', 0]. */
function wallFace(f) {
  const face = ['x-', 'x+', 'y-', 'y+', 'z-', 'z+'].includes(f.face) ? f.face : 'x-';
  return { axis: face[0], value: face[1] === '+' ? 1 : 0 };
}

/**
 * Interactive translate gizmos for custom-scene fixations and forces.
 *
 * @param {{
 *   scene: THREE.Scene,
 *   camera: THREE.Camera,
 *   domElement: HTMLElement,
 *   controls?: { enabled: boolean } | null,
 *   getConfig: () => { nx: number, ny: number, nz: number, scene?: import('../scene/types.js').Scene | null },
 *   onSceneChanged?: () => void,
 *   onSelect?: (sel: { id: string } | null) => void,
 * }} opts
 */
export function createSceneGizmoController({ scene, camera, domElement, controls, getConfig, onSceneChanged, onSelect, onDragMove }) {
  const group = new THREE.Group();
  group.name = 'scene-gizmo-proxies';
  group.visible = false;
  scene.add(group);

  const tc = new TransformControls(camera, domElement);
  tc.setMode('translate');
  tc.setSize(0.8);
  tc.enabled = false;
  const helper = tc.getHelper();
  helper.visible = false;
  scene.add(helper);

  /** @type {Map<string, THREE.Mesh>} keyed by featureId */
  const proxies = new Map();
  const mats = new Map();
  const geoms = {
    sphere: new THREE.SphereGeometry(1, 20, 14),
    cube: new THREE.BoxGeometry(1.6, 1.6, 1.6),
  };

  /** Dimension lines for distance links */
  const linkGroup = new THREE.Group();
  linkGroup.name = 'scene-gizmo-links';
  group.add(linkGroup);
  const linkMat = new THREE.LineBasicMaterial({
    color: 0xfbbf24,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
  });
  const materialFor = (hex) => {
    let m = mats.get(hex);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color: hex,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false,
      });
      mats.set(hex, m);
    }
    return m;
  };

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const camPos = new THREE.Vector3();

  let enabled = false;
  let dragging = false;
  /** @type {string | null} */
  let selectedId = null;
  let downX = 0;
  let downY = 0;
  let downHitProxy = false;

  /* ---------------- lookup ---------------- */
  function findFeature(id) {
    const sc = getConfig().scene;
    if (!sc || !id) return null;
    return sc.components?.find((f) => f.id === id) ?? null;
  }

  /** Constrain a wall pad proxy to its face plane and hide the gizmo handle for that axis. */
  function applyAxisVisibility(proxy) {
    tc.showX = tc.showY = tc.showZ = true;
    if (!proxy) return;
    const f = findFeature(proxy.userData.featureId);
    if (f?.type === 'wall_pad') {
      const { axis } = wallFace(f);
      if (axis === 'x') tc.showX = false;
      else if (axis === 'y') tc.showY = false;
      else tc.showZ = false;
    }
  }

  /* ---------------- proxy lifecycle ---------------- */
  function clearProxies() {
    tc.detach();
    for (const m of proxies.values()) group.remove(m);
    proxies.clear();
    clearLinkLines();
  }

  function makeProxy(feature) {
    const roles = componentDef(feature.type)?.roles(feature) ?? { support: false, load: true };
    const hex = roles.support ? (COLORS[feature.type] ?? COLORS.rest_point) : COLORS.force;
    const useCube = feature.type === 'wall_pad' || feature.type === 'pressure' || feature.type === 'point_load';
    const mesh = new THREE.Mesh(useCube ? geoms.cube : geoms.sphere, materialFor(hex));
    mesh.name = `gizmo-${feature.id}`;
    mesh.renderOrder = 1000;
    mesh.userData.featureId = feature.id;
    // Keep a roughly constant on-screen size regardless of zoom.
    mesh.onBeforeRender = (_r, _s, cam) => {
      mesh.getWorldPosition(camPos);
      const d = camPos.distanceTo(cam.position);
      const s = THREE.MathUtils.clamp(d * 0.018, 0.5, 4);
      if (Math.abs(mesh.scale.x - s) > 1e-3) {
        mesh.scale.setScalar(s);
        mesh.updateMatrixWorld();
      }
    };
    return mesh;
  }

  function placeProxy(mesh, feature, cfg) {
    let { x, y, z } = feature;
    if (feature.type === 'wall_pad') {
      const { axis, value } = wallFace(feature);
      if (axis === 'x') x = value;
      else if (axis === 'y') y = value;
      else z = value;
    }
    const w = normToWorld(cfg, x, y, z);
    mesh.position.set(w.x, w.y, w.z);
  }

  function clearLinkLines() {
    while (linkGroup.children.length) {
      const c = linkGroup.children[0];
      linkGroup.remove(c);
      c.geometry?.dispose?.();
    }
  }

  function syncLinkLines(cfg) {
    clearLinkLines();
    const sc = cfg.scene;
    if (!sc) return;
    for (const link of ensureLinks(sc)) {
      if (link.type !== 'rigid') continue;
      const a = findComponent(sc, link.aId);
      const b = findComponent(sc, link.bId);
      if (!a || !b) continue;
      const wa = normToWorld(cfg, a.x, a.y, a.z);
      const wb = normToWorld(cfg, b.x, b.y, b.z);
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(wa.x, wa.y, wa.z),
        new THREE.Vector3(wb.x, wb.y, wb.z),
      ]);
      const line = new THREE.Line(geo, linkMat);
      line.renderOrder = 999;
      line.userData.linkId = link.id;
      linkGroup.add(line);
    }
  }

  /** Rebuild all proxies from `config.scene`. Keeps the current selection when possible. */
  function syncFromScene() {
    const cfg = getConfig();
    const prevSel = selectedId;
    clearProxies();
    const sc = cfg.scene;
    if (sc) {
      for (const f of sc.components ?? []) {
        const m = makeProxy(f);
        placeProxy(m, f, cfg);
        group.add(m);
        proxies.set(f.id, m);
      }
    }
    // Re-parent link group after clearProxies removed children from `group`.
    if (!group.children.includes(linkGroup)) group.add(linkGroup);
    syncLinkLines(cfg);
    group.updateMatrixWorld(true);
    if (enabled && prevSel && proxies.has(prevSel)) select(prevSel);
    else selectedId = null;
  }

  function select(id, { silent = false } = {}) {
    const proxy = id ? proxies.get(id) : null;
    if (!proxy || !enabled) {
      tc.detach();
      selectedId = null;
      helper.visible = false;
      if (!silent) onSelect?.(null);
      return;
    }
    selectedId = id;
    applyAxisVisibility(proxy);
    tc.attach(proxy);
    helper.visible = true;
    if (!silent) {
      onSelect?.({ id });
    }
  }

  /** Select from the sidebar without re-notifying the editor. */
  function selectById(id) {
    select(id, { silent: true });
  }

  /* ---------------- picking ---------------- */
  function pick(ev) {
    const rect = domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(group.children, false);
    return hits.length ? hits[0].object : null;
  }

  function onPointerDown(ev) {
    if (!enabled || ev.button !== 0) return;
    downX = ev.clientX;
    downY = ev.clientY;
    downHitProxy = false;

    // A gizmo handle under the pointer wins: stop OrbitControls before it sees the event.
    if (tc.object && tc.axis) {
      controls && (controls.enabled = false);
      downHitProxy = true;
      return;
    }
    const hit = pick(ev);
    if (hit) {
      downHitProxy = true;
      select(hit.userData.featureId);
    }
  }

  function onPointerUp(ev) {
    if (!enabled || ev.button !== 0) return;
    if (dragging) return;
    // Plain click on empty space (not an orbit drag) → deselect.
    const moved = Math.hypot(ev.clientX - downX, ev.clientY - downY);
    if (!downHitProxy && moved < 4 && selectedId) select(null);
    if (controls && !dragging) controls.enabled = true;
  }

  /* ---------------- transform events ---------------- */
  tc.addEventListener('dragging-changed', (e) => {
    dragging = !!e.value;
    if (controls) controls.enabled = !dragging;
  });

  function refreshProxyPositions(cfg, ids) {
    const sc = cfg.scene;
    if (!sc) return;
    for (const id of ids) {
      const mesh = proxies.get(id);
      if (!mesh) continue;
      const hit = findComponent(sc, id);
      if (!hit) continue;
      placeProxy(mesh, hit, cfg);
    }
    syncLinkLines(cfg);
  }

  tc.addEventListener('objectChange', () => {
    const proxy = tc.object;
    if (!proxy) return;
    const cfg = getConfig();
    const f = findFeature(proxy.userData.featureId);
    if (!f) return;
    const n = worldToNorm(cfg, proxy.position.x, proxy.position.y, proxy.position.z);
    if (f.type === 'wall_pad') {
      const { axis, value } = wallFace(f);
      n[axis] = value;
    }
    // Write back the clamped position so the proxy cannot leave the domain.
    const w = {
      x: n.x * cfg.nx - cfg.nx / 2,
      y: n.y * cfg.ny - cfg.ny / 2,
      z: n.z * cfg.nz - cfg.nz / 2,
    };
    proxy.position.set(w.x, w.y, w.z);
    f.x = n.x;
    f.y = n.y;
    f.z = n.z;

    // Keep linked partners (and colocated bearings) at fixed spacing.
    if (cfg.scene) {
      const touched = applyLinksAfterMove(cfg.scene, f.id);
      refreshProxyPositions(cfg, touched);
    }
    onDragMove?.();
  });

  tc.addEventListener('mouseUp', () => {
    dragging = false;
    if (controls) controls.enabled = true;
    const proxy = tc.object;
    if (proxy) {
      // Snap to the grid node the solver will actually use.
      const cfg = getConfig();
      const f = findFeature(proxy.userData.featureId);
      if (f && cfg.scene) {
        const ix = clampInt(Math.round(f.x * cfg.nx), 0, cfg.nx);
        const iy = clampInt(Math.round(f.y * cfg.ny), 0, cfg.ny);
        const iz = clampInt(Math.round(f.z * cfg.nz), 0, cfg.nz);
        f.x = ix / cfg.nx;
        f.y = iy / cfg.ny;
        f.z = iz / cfg.nz;
        // Partners follow with their stored rigid offsets (grid-snapped when the link
        // was made) — never snap them independently or the spacing would drift.
        const touched = applyLinksAfterMove(cfg.scene, f.id);
        refreshProxyPositions(cfg, touched);
      }
    }
    onSceneChanged?.();
  });

  domElement.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerUp);

  /* ---------------- public API ---------------- */
  function setEnabled(on) {
    enabled = !!on;
    tc.enabled = enabled;
    group.visible = enabled;
    if (!enabled) {
      tc.detach();
      helper.visible = false;
      selectedId = null;
      dragging = false;
      if (controls) controls.enabled = true;
    }
  }

  function dispose() {
    domElement.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointerup', onPointerUp);
    tc.detach();
    tc.dispose();
    clearLinkLines();
    linkMat.dispose();
    scene.remove(helper);
    scene.remove(group);
    group.clear();
    proxies.clear();
    Object.values(geoms).forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    if (controls) controls.enabled = true;
  }

  return { syncFromScene, setEnabled, selectById, dispose };
}
