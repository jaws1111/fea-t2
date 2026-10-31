/**
 * Working / design volume — the AABB of elements the optimizer may fill.
 * Outside the volume is permanent void (non-design space).
 *
 * Coordinates are normalized [0,1] over the FEA domain. Auto mode needs the grid
 * dims because feature sizes (hole radius, cavity radius, wall) are in CELLS:
 * radius is a fraction of max(nx, ny, nz), not of each axis.
 */

import {
  holeBossOuterCells,
  holeRadiusCells,
  holeSpan,
  perpAxes,
  pressureExtentCells,
  validAxis,
} from './geometry.js';

/** @typedef {'full'|'auto'|'manual'} WorkingVolumeMode */

/**
 * @typedef {Object} WorkingBounds
 * @property {number} x0 @property {number} x1
 * @property {number} y0 @property {number} y1
 * @property {number} z0 @property {number} z1
 */

/**
 * @typedef {Object} WorkingVolume
 * @property {WorkingVolumeMode} mode
 * @property {number} padding   auto-mode margin as fraction of domain
 * @property {WorkingBounds} bounds
 */

const FULL = Object.freeze({ x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 });
const DEFAULT_DIMS = Object.freeze({ nx: 32, ny: 32, nz: 32 });

/** @returns {WorkingVolume} */
export function createDefaultWorkingVolume() {
  return { mode: 'auto', padding: 0.06, bounds: { ...FULL } };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function newBounds() {
  return { x0: 1, x1: 0, y0: 1, y1: 0, z0: 1, z1: 0 };
}

/** Grow bounds by a box: centre (normalized) ± half-extents (cells). */
function addBox(b, dims, cx, cy, cz, hxC, hyC, hzC) {
  b.x0 = Math.min(b.x0, cx - hxC / dims.nx);
  b.x1 = Math.max(b.x1, cx + hxC / dims.nx);
  b.y0 = Math.min(b.y0, cy - hyC / dims.ny);
  b.y1 = Math.max(b.y1, cy + hyC / dims.ny);
  b.z0 = Math.min(b.z0, cz - hzC / dims.nz);
  b.z1 = Math.max(b.z1, cz + hzC / dims.nz);
}

const num = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * Fit an AABB around every scene feature, incl. bolt bosses, pressure cavities
 * + walls, wall pads, rests and point loads.
 *
 * @param {import('./types.js').Scene | null | undefined} scene
 * @param {number} [padding]
 * @param {{ nx: number, ny: number, nz: number }} [dims]
 * @returns {WorkingBounds}
 */
export function computeAutoWorkingBounds(scene, padding = 0.06, dims = DEFAULT_DIMS) {
  const feats = [...(scene?.fixations ?? []), ...(scene?.forces ?? [])];
  if (!feats.length) return { ...FULL };

  const maxDim = Math.max(dims.nx, dims.ny, dims.nz);
  const nOf = { x: dims.nx, y: dims.ny, z: dims.nz };
  const b = newBounds();
  let any = false;

  for (const f of feats) {
    if (!f) continue;
    const x = num(f.x, 0.5);
    const y = num(f.y, 0.5);
    const z = num(f.z, 0.5);

    if (f.type === 'wall_pad') {
      any = true;
      const face = ['x-', 'x+', 'y-', 'y+', 'z-', 'z+'].includes(f.face) ? f.face : 'x-';
      const axis = face[0];
      const [pa, pb] = perpAxes(axis);
      const c = { x, y, z };
      const halfU = (Math.max(0.05, num(f.width, 1)) / 2) * nOf[pa];
      const halfV = (Math.max(0.05, num(f.height, 1)) / 2) * nOf[pb];
      const layers = Math.max(2, Math.round(num(f.depth, 1))) + 1;
      const half = { x: 0, y: 0, z: 0 };
      half[pa] = halfU;
      half[pb] = halfV;
      // Pad sits on its face and reaches `layers` cells into the domain.
      const faceN = face[1] === '+' ? 1 : 0;
      const into = face[1] === '+' ? -layers / 2 : layers / 2;
      const cen = { x: c.x, y: c.y, z: c.z };
      cen[axis] = faceN + into / nOf[axis];
      half[axis] = layers / 2;
      addBox(b, dims, cen.x, cen.y, cen.z, half.x, half.y, half.z);
      continue;
    }

    if (f.type === 'bolt_hole') {
      any = true;
      const axis = validAxis(f.axis);
      const Rs = holeBossOuterCells(holeRadiusCells(f.radius, maxDim));
      const half = { x: Rs, y: Rs, z: Rs };
      const [lo, hi] = holeSpan(f);
      const cen = { x, y, z };
      cen[axis] = (lo + hi) / 2;
      half[axis] = ((hi - lo) / 2) * nOf[axis];
      addBox(b, dims, cen.x, cen.y, cen.z, half.x, half.y, half.z);
      continue;
    }

    if (f.type === 'pressure') {
      any = true;
      const e = pressureExtentCells(f, dims);
      addBox(b, dims, x, y, z, e.hx, e.hy, e.hz);
      continue;
    }

    if (f.type === 'rest_point') {
      any = true;
      const r = Math.max(1.5, num(f.radius, 0.03) * maxDim * 1.5) + 1;
      addBox(b, dims, x, y, z, r, r, r);
      continue;
    }

    // point_load and anything else: a few cells around the application point.
    any = true;
    addBox(b, dims, x, y, z, 2.5, 2.5, 2.5);
  }

  if (!any) return { ...FULL };

  const pad = Math.max(0, padding);
  return {
    x0: clamp01(b.x0 - pad),
    x1: clamp01(b.x1 + pad),
    y0: clamp01(b.y0 - pad),
    y1: clamp01(b.y1 + pad),
    z0: clamp01(b.z0 - pad),
    z1: clamp01(b.z1 + pad),
  };
}

/**
 * Effective working bounds for a scene on a given grid.
 * @param {import('./types.js').Scene | null | undefined} scene
 * @param {{ nx: number, ny: number, nz: number }} [dims]
 * @returns {WorkingBounds}
 */
export function resolveWorkingBounds(scene, dims = DEFAULT_DIMS) {
  const wv = scene?.workingVolume;
  if (!wv || wv.mode === 'full') return { ...FULL };
  if (wv.mode === 'manual' && wv.bounds) return sanitizeBounds(wv.bounds);
  const bounds = computeAutoWorkingBounds(scene, wv.padding ?? 0.06, dims);
  wv.bounds = bounds; // cache for UI
  return bounds;
}

/** @param {WorkingBounds} b */
export function sanitizeBounds(b) {
  const g = (v, d) => clamp01(Number.isFinite(Number(v)) ? Number(v) : d);
  let x0 = g(b.x0, 0);
  let x1 = g(b.x1, 1);
  let y0 = g(b.y0, 0);
  let y1 = g(b.y1, 1);
  let z0 = g(b.z0, 0);
  let z1 = g(b.z1, 1);
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (z1 < z0) [z0, z1] = [z1, z0];
  const thin = (lo, hi) => {
    if (hi - lo >= 0.05) return [lo, hi];
    const m = 0.5 * (lo + hi);
    return [clamp01(m - 0.025), clamp01(m + 0.025)];
  };
  [x0, x1] = thin(x0, x1);
  [y0, y1] = thin(y0, y1);
  [z0, z1] = thin(z0, z1);
  return { x0, x1, y0, y1, z0, z1 };
}

/**
 * Ensure scene.workingVolume exists and its cached bounds are current.
 * @param {import('./types.js').Scene} scene
 * @param {{ nx: number, ny: number, nz: number }} [dims]
 */
export function ensureWorkingVolume(scene, dims = DEFAULT_DIMS) {
  if (!scene.workingVolume) scene.workingVolume = createDefaultWorkingVolume();
  const wv = scene.workingVolume;
  if (wv.mode !== 'full' && wv.mode !== 'auto' && wv.mode !== 'manual') wv.mode = 'auto';
  if (!Number.isFinite(wv.padding)) wv.padding = 0.06;
  if (wv.mode === 'auto') wv.bounds = computeAutoWorkingBounds(scene, wv.padding, dims);
  else if (wv.mode === 'manual') wv.bounds = sanitizeBounds(wv.bounds ?? FULL);
  else wv.bounds = { ...FULL };
  return wv;
}
