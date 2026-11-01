/**
 * Custom scene definition for TopoOpt.
 *
 * All coordinates are NORMALIZED to the design domain: 0 = min, 1 = max along
 * nx / ny / nz respectively. Radii and sizes are normalized too:
 *   - radius      : fraction of max(nx, ny, nz)  (NOT per-axis)
 *   - width/height: fraction of the face extent along the respective in-plane axis
 *
 * A scene is one list of components. Each component's `type` selects a definition
 * in `src/scene/components/`. Scenes are plain JSON (safe to postMessage).
 */

import { componentDef } from './components/index.js';
import { reserveIds } from './components/ids.js';
import { validAxis } from './geometry.js';
import { createRigidLink, ensureLinks, pruneLinks } from './links.js';
import { createDefaultWorkingVolume, normalizeWorkingShape } from './workingVolume.js';

/**
 * @typedef {'rest_point'|'rest_line'|'rest_ring'|'rest_pad'|'bolt_hole'|'wall_pad'|'wall_cylinder'|'wall_prism'|'surround'|'block'|'point_load'|'line_load'|'face_load'|'pressure'} ComponentType
 * @typedef {'x'|'y'|'z'} Axis
 * @typedef {'x-'|'x+'|'y-'|'y+'|'z-'|'z+'} Face
 * @typedef {'none'|'directional'|'multi'|'circular'} BoltLoadMode
 */

/** @type {readonly Face[]} */
export const FACES = Object.freeze(['x-', 'x+', 'y-', 'y+', 'z-', 'z+']);

/** @type {readonly BoltLoadMode[]} */
export const BOLT_LOAD_MODES = Object.freeze(['none', 'directional', 'multi', 'circular']);

/**
 * One fixation, load, or both. Fields stay flat on the object (`c.radius`, not `c.params`).
 * Per-type fields match the v2 fixation and force objects.
 *
 * @typedef {Object} Component
 * @property {string} id
 * @property {ComponentType} type
 * @property {number} x @property {number} y @property {number} z
 */

/**
 * @typedef {Object} Scene
 * @property {3} version
 * @property {Component[]} components
 * @property {import('./links.js').RigidLink[]} links
 * @property {import('./workingVolume.js').WorkingVolume} workingVolume
 */

/**
 * @param {string} type
 * @param {Record<string, any>} [partial]
 * @returns {Component}
 */
export function createComponent(type, partial = {}) {
  const def = componentDef(type);
  if (!def) throw new Error(`Unknown component type: ${type}`);
  return def.create(partial);
}

/**
 * A bolt hole that is only a load application point (all axes free).
 * @param {Record<string, any>} [partial]
 */
export function createLoadedHole(partial = {}) {
  return createComponent('bolt_hole', {
    fixX: false,
    fixY: false,
    fixZ: false,
    loadMode: 'directional',
    ...partial,
  });
}

/** @returns {Scene} */
export function createEmptyScene() {
  return {
    version: 3,
    components: [],
    links: [],
    workingVolume: createDefaultWorkingVolume(),
  };
}

/** @param {Scene | null | undefined} scene */
export function isSceneEmpty(scene) {
  return !scene || (scene.components?.length ?? 0) === 0;
}

/**
 * Fold legacy `bolt_bearing` forces into the colocated bolt hole, or into a new
 * free hole. Returns id remap (bearing id → hole id). Mutates the two arrays.
 * @param {{ fixations: any[], forces: any[] }} scene
 */
function mergeBoltBearings(scene) {
  /** @type {Map<string, string>} */
  const remap = new Map();
  const keep = [];
  for (const f of scene.forces) {
    if (f?.type !== 'bolt_bearing') {
      keep.push(f);
      continue;
    }
    const axis = validAxis(f.axis);
    const len = Math.hypot(f.fx || 0, f.fy || 0, f.fz || 0) || 1;
    const dir = [(f.fx || 0) / len, (f.fy || 0) / len, (f.fz || 0) / len];
    let hole = scene.fixations.find(
      (h) =>
        h?.type === 'bolt_hole' &&
        validAxis(h.axis) === axis &&
        (h.loadMode ?? 'none') === 'none' &&
        Math.hypot(h.x - f.x, h.y - f.y, h.z - f.z) <= 0.04,
    );
    if (hole) {
      if (Math.abs(dir[0]) > 1e-3) hole.fixX = false;
      if (Math.abs(dir[1]) > 1e-3) hole.fixY = false;
      if (Math.abs(dir[2]) > 1e-3) hole.fixZ = false;
    } else {
      hole = createComponent('bolt_hole', {
        x: f.x,
        y: f.y,
        z: f.z,
        axis,
        radius: f.radius ?? 0.04,
        fixX: false,
        fixY: false,
        fixZ: false,
      });
      scene.fixations.push(hole);
    }
    hole.loadMode = 'directional';
    hole.fx = f.fx ?? 0;
    hole.fy = f.fy ?? -1;
    hole.fz = f.fz ?? 0;
    hole.magnitude = Number.isFinite(f.magnitude) ? f.magnitude : 1;
    if (f.id) remap.set(f.id, hole.id);
  }
  scene.forces = keep;
  return remap;
}

/**
 * Legacy `distance` links become rigid offset links. Rigid links are kept.
 * Runs before per-type normalize so a span migration does not change the stored offset.
 * @param {Scene} scene
 * @param {Map<string, string>} remap
 */
function repairLinks(scene, remap) {
  const features = new Map();
  for (const c of scene.components) if (c?.id) features.set(c.id, c);
  scene.links = ensureLinks(scene)
    .map((l) => {
      const aId = remap.get(l.aId) ?? l.aId;
      const bId = remap.get(l.bId) ?? l.bId;
      if (l.type === 'rigid' && Number.isFinite(l.dx)) return { ...l, aId, bId };
      const a = features.get(aId);
      const b = features.get(bId);
      if (!a || !b) return null;
      return createRigidLink({
        id: l.id,
        aId,
        bId,
        dx: b.x - a.x,
        dy: b.y - a.y,
        dz: b.z - a.z,
      });
    })
    .filter((l) => l && l.aId !== l.bId);
}

/**
 * Bring any scene (old saves, undo snapshots, hand-built) to v3.
 * Idempotent. Mutates and returns the scene.
 *
 * v1 and v2 store `fixations` and `forces`. Those lists are concatenated,
 * supports first, then loads, and then deleted.
 *
 * @param {Scene | Record<string, any> | null | undefined} scene
 * @returns {Scene}
 */
export function normalizeScene(scene) {
  if (!scene || typeof scene !== 'object') return createEmptyScene();

  /** @type {Map<string, string>} */
  let remap = new Map();
  if (Array.isArray(scene.fixations) || Array.isArray(scene.forces)) {
    if (!Array.isArray(scene.fixations)) scene.fixations = [];
    if (!Array.isArray(scene.forces)) scene.forces = [];
    remap = mergeBoltBearings(scene);
    scene.components = [...scene.fixations, ...scene.forces].filter(Boolean);
    delete scene.fixations;
    delete scene.forces;
  }

  if (!Array.isArray(scene.components)) scene.components = [];
  scene.components = scene.components.filter((c) => c && componentDef(c.type));
  repairLinks(scene, remap);
  for (const c of scene.components) componentDef(c.type).normalize(c);
  reserveIds(scene.components);

  if (!scene.workingVolume) scene.workingVolume = createDefaultWorkingVolume();
  normalizeWorkingShape(scene.workingVolume);
  ensureLinks(scene);
  pruneLinks(scene);
  scene.version = 3;
  return scene;
}
