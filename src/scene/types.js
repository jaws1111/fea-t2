/**
 * Custom scene definition for TopoOpt.
 *
 * All coordinates are NORMALIZED to the design domain: 0 = min, 1 = max along
 * nx / ny / nz respectively. Radii and sizes are normalized too:
 *   - radius      : fraction of max(nx, ny, nz)  (NOT per-axis)
 *   - width/height: fraction of the face extent along the respective in-plane axis
 *
 * Scenes are plain JSON-serialisable objects (safe to postMessage to the worker).
 */

import { createDefaultWorkingVolume } from './workingVolume.js';
import { createRigidLink, ensureLinks, pruneLinks } from './links.js';
import { validAxis } from './geometry.js';
import { POINT_DIRS, pointLoadAxes, pointLoadDirs, pointLoadMode } from './pointLoad.js';

/**
 * @typedef {'rest_point'|'bolt_hole'|'wall_pad'} FixationType
 * @typedef {'point_load'|'pressure'} ForceType
 * @typedef {'x'|'y'|'z'} Axis
 * @typedef {'x-'|'x+'|'y-'|'y+'|'z-'|'z+'} Face
 * @typedef {'none'|'directional'|'multi'|'circular'} BoltLoadMode
 */

/** @type {readonly FixationType[]} */
export const FIXATION_TYPES = Object.freeze(['rest_point', 'bolt_hole', 'wall_pad']);

/** @type {readonly ForceType[]} */
export const FORCE_TYPES = Object.freeze(['point_load', 'pressure']);

/** @type {readonly Face[]} */
export const FACES = Object.freeze(['x-', 'x+', 'y-', 'y+', 'z-', 'z+']);

/** @type {readonly BoltLoadMode[]} */
export const BOLT_LOAD_MODES = Object.freeze(['none', 'directional', 'multi', 'circular']);

/**
 * A support, mounting hole or pad.
 *
 * rest_point : small sphere of nodes around (x,y,z) (a "foot" on the ground).
 * wall_pad   : rectangular patch on `face`, `width` × `height`, `depth` layers.
 * bolt_hole  : ONE object for a bolt / pin hole. A through-bore along `axis`
 *              of user-defined length `len` (centred on the hole) with a locked solid boss around
 *              it. It carries BOTH its constraint and its load:
 *                fixX/fixY/fixZ  which translations the hole clamps
 *                loadMode        'none' | 'directional' (one vector) |
 *                                'multi' (several vectors) | 'circular'
 *                directional : fx,fy,fz + magnitude, applied as bearing on the
 *                              bore wall facing the load
 *                multi       : loads[] of {fx,fy,fz,magnitude}, each a bearing
 *                circular    : circMode 'torque' (tangential, signed magnitude =
 *                              CCW/CW about +axis) or 'radial' (press-fit; +out)
 *              A load component along a FIXED axis is absorbed by the support
 *              (the editor warns) — free the axis to let the load reach the part.
 *
 * @typedef {Object} Fixation
 * @property {string} id
 * @property {FixationType} type
 * @property {number} x @property {number} y @property {number} z
 * @property {number} radius
 * @property {Axis} axis
 * @property {number} len bolt_hole length along its axis (fraction of the domain, default 0.25),
 *                        centred on the hole's coordinate along that axis
 * @property {Face} face
 * @property {number} width @property {number} height @property {number} depth
 * @property {boolean} fixX @property {boolean} fixY @property {boolean} fixZ
 * @property {BoltLoadMode} loadMode
 * @property {number} fx @property {number} fy @property {number} fz
 * @property {number} magnitude
 * @property {{ fx: number, fy: number, fz: number, magnitude: number }[]} loads
 * @property {'torque'|'radial'} circMode
 */

/**
 * A free-standing load.
 *
 * point_load : force at the node nearest (x,y,z). With `axes` 2..6 it carries |F| along each
 *              chosen axis direction (`dirs`, e.g. 'x+','y-'): `axesMode` 'cases' (default) =
 *              separate load cases the supports react one by one, 'burst' = all at once, each
 *              `radius` cells out along its direction. See pointLoad.js.
 * pressure   : distributed load on a cavity wall ('sphere' `radius`, or 'box'
 *              half-extents hx,hy,hz). `pressureMode: 'radial'` pushes outward from
 *              the centre (`inward`/negative magnitude flips); 'directional' pushes
 *              along (fx,fy,fz) on the facing half. With `cavityVoid` (default) the
 *              cavity interior is permanent void and a `wall`-cell solid wall is
 *              locked around it so the pressure always has material to act on.
 *
 * (Bolt-bearing loads now live ON the bolt_hole; legacy `bolt_bearing` forces are
 * migrated by `normalizeScene`.)
 *
 * @typedef {Object} Force
 * @property {string} id
 * @property {ForceType} type
 * @property {number} x @property {number} y @property {number} z
 * @property {number} fx @property {number} fy @property {number} fz
 * @property {number} magnitude
 * @property {number} radius
 * @property {'sphere'|'box'} shape
 * @property {number} hx @property {number} hy @property {number} hz
 * @property {'radial'|'directional'} pressureMode
 * @property {boolean} inward
 * @property {boolean} cavityVoid
 * @property {number} wall   wall thickness in cells
 * @property {number} [axes]  point_load: number of force axes 1..6 (default 1)
 * @property {string[]} [dirs] point_load: chosen directions when axes > 1 ('x+', 'x-', ...)
 * @property {'cases'|'burst'} [axesMode] point_load with axes > 1: separate load cases or one burst
 */

/**
 * @typedef {Object} Scene
 * @property {number} version
 * @property {Fixation[]} fixations
 * @property {Force[]} forces
 * @property {import('./workingVolume.js').WorkingVolume} [workingVolume]
 * @property {import('./links.js').RigidLink[]} [links]
 */

let _idCounter = 0;
function nextId(prefix) {
  _idCounter += 1;
  return `${prefix}_${_idCounter}`;
}

export { nextId };

/** @returns {Scene} */
export function createEmptyScene() {
  return {
    version: 2,
    fixations: [],
    forces: [],
    links: [],
    workingVolume: createDefaultWorkingVolume(),
  };
}

/**
 * @param {Partial<Fixation>} [partial]
 * @returns {Fixation}
 */
export function createFixation(partial = {}) {
  const type = partial.type ?? 'rest_point';
  /** @type {Fixation} */
  const base = {
    id: nextId('fix'),
    type,
    x: 0.5,
    y: 0,
    z: 0.5,
    radius: type === 'bolt_hole' ? 0.04 : 0.03,
    axis: 'z',
    len: 0.25,
    face: 'x-',
    width: 1,
    height: 1,
    depth: 1,
    fixX: true,
    fixY: true,
    fixZ: true,
    loadMode: 'none',
    fx: 0,
    fy: -1,
    fz: 0,
    magnitude: 1,
    loads: [],
    circMode: 'torque',
  };
  const out = { ...base, ...stripUndefined(partial) };
  if (type === 'bolt_hole') migrateHoleSpan(out, Number.isFinite(partial.len));
  return out;
}

/**
 * Legacy holes stored an absolute axial span [s0, s1]. The span is now `len` centred on
 * the hole's own coordinate along its axis (short pins stay short, independent of the
 * domain). Converts in place; a no-op for current data.
 * @param {Record<string, any>} f
 * @param {boolean} [explicitLen]  `len` was supplied by the caller (wins over s0/s1)
 */
export function migrateHoleSpan(f, explicitLen = false) {
  const hasLegacy = Number.isFinite(f.s0) || Number.isFinite(f.s1);
  if (hasLegacy && !explicitLen) {
    const a = Number.isFinite(f.s0) ? f.s0 : 0;
    const b = Number.isFinite(f.s1) ? f.s1 : 1;
    const axis = f.axis === 'x' || f.axis === 'y' || f.axis === 'z' ? f.axis : 'z';
    f.len = Math.min(1, Math.max(0.01, Math.abs(b - a)));
    f[axis] = (a + b) / 2;
  }
  delete f.s0;
  delete f.s1;
  if (!Number.isFinite(f.len)) f.len = 0.25;
  f.len = Math.min(1, Math.max(0.01, f.len));
}

/**
 * @param {Partial<Force>} [partial]
 * @returns {Force}
 */
export function createForce(partial = {}) {
  const type = partial.type ?? 'point_load';
  /** @type {Force} */
  const base = {
    id: nextId('force'),
    type,
    x: 0.5,
    y: 1,
    z: 0.5,
    fx: 0,
    fy: -1,
    fz: 0,
    magnitude: 1,
    radius: type === 'pressure' ? 0.12 : 0.04,
    shape: 'sphere',
    hx: 0.1,
    hy: 0.1,
    hz: 0.1,
    pressureMode: 'radial',
    inward: false,
    cavityVoid: true,
    wall: 2,
    axes: 1,
    dirs: [],
    axesMode: 'cases',
  };
  const out = { ...base, ...stripUndefined(partial) };
  if (type === 'point_load' && out.axes > 1 && !(out.dirs?.length >= out.axes)) {
    out.dirs = pointLoadDirs(out);
  }
  return out;
}

/**
 * Convenience: a bolt hole that is only a LOAD application point (all axes free).
 * @param {Partial<Fixation>} partial
 */
export function createLoadedHole(partial = {}) {
  return createFixation({
    type: 'bolt_hole',
    fixX: false,
    fixY: false,
    fixZ: false,
    loadMode: 'directional',
    ...partial,
  });
}

/** @param {Record<string, any>} obj */
function stripUndefined(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** @param {Scene | null | undefined} scene */
export function isSceneEmpty(scene) {
  return !scene || ((scene.fixations?.length ?? 0) === 0 && (scene.forces?.length ?? 0) === 0);
}

/**
 * Bring any scene (old saves, undo snapshots, hand-built) to the current schema.
 * Idempotent; mutates and returns the scene.
 *
 *  - legacy `bolt_bearing` forces are merged into the colocated bolt_hole (its
 *    load axes are un-fixed so the load actually transmits) or become a free
 *    loaded hole; links are re-pointed.
 *  - legacy 'distance' links become rigid offset links.
 *  - missing bolt-hole / pressure fields get defaults.
 *
 * @param {Scene | null | undefined} scene
 * @returns {Scene}
 */
export function normalizeScene(scene) {
  if (!scene) return createEmptyScene();
  if (!Array.isArray(scene.fixations)) scene.fixations = [];
  if (!Array.isArray(scene.forces)) scene.forces = [];
  if (!scene.workingVolume) scene.workingVolume = createDefaultWorkingVolume();
  ensureLinks(scene);
  scene.version = 2;

  // --- legacy bolt_bearing → hole load ---
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
        h.type === 'bolt_hole' &&
        validAxis(h.axis) === axis &&
        (h.loadMode ?? 'none') === 'none' &&
        Math.hypot(h.x - f.x, h.y - f.y, h.z - f.z) <= 0.04,
    );
    if (hole) {
      if (Math.abs(dir[0]) > 1e-3) hole.fixX = false;
      if (Math.abs(dir[1]) > 1e-3) hole.fixY = false;
      if (Math.abs(dir[2]) > 1e-3) hole.fixZ = false;
    } else {
      hole = createFixation({
        type: 'bolt_hole',
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
    remap.set(f.id, hole.id);
  }
  scene.forces = keep;

  // --- links: legacy conversion + re-point ---
  const features = new Map();
  for (const f of scene.fixations) features.set(f.id, f);
  for (const f of scene.forces) features.set(f.id, f);
  scene.links = scene.links
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

  // --- field defaults ---
  for (const f of scene.fixations) {
    if (f.type !== 'bolt_hole') continue;
    if (!BOLT_LOAD_MODES.includes(f.loadMode)) f.loadMode = 'none';
    if (!Array.isArray(f.loads)) f.loads = [];
    // Legacy absolute span -> length centred on the hole (no-op for current scenes).
    // (a legacy hole with neither len nor span was full-axis)
    if (!Number.isFinite(f.len) && !Number.isFinite(f.s0) && !Number.isFinite(f.s1)) f.len = 1;
    migrateHoleSpan(f, Number.isFinite(f.len));
    if (f.circMode !== 'radial') f.circMode = 'torque';
    if (!Number.isFinite(f.fx)) f.fx = 0;
    if (!Number.isFinite(f.fy)) f.fy = -1;
    if (!Number.isFinite(f.fz)) f.fz = 0;
    if (!Number.isFinite(f.magnitude)) f.magnitude = 1;
  }
  for (const f of scene.forces) {
    if (f.type === 'point_load') {
      f.axes = pointLoadAxes(f);
      f.axesMode = pointLoadMode(f);
      f.dirs = f.axes > 1 ? pointLoadDirs(f) : Array.isArray(f.dirs) ? f.dirs.filter((d) => POINT_DIRS.includes(d)) : [];
      continue;
    }
    if (f.type !== 'pressure') continue;
    if (typeof f.cavityVoid !== 'boolean') f.cavityVoid = true;
    if (!Number.isFinite(f.wall)) f.wall = 2;
  }

  pruneLinks(scene);
  return scene;
}
