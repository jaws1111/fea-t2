/**
 * Working / design volume — the AABB of elements the optimizer may fill.
 * Outside the volume is permanent void (non-design space).
 *
 * Coordinates are normalized [0,1] over the FEA domain. Auto mode needs the grid
 * dims because feature sizes (hole radius, cavity radius, wall) are in CELLS:
 * radius is a fraction of max(nx, ny, nz), not of each axis.
 */

import { componentDef, orderedFeatures } from './components/index.js';

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

/** Thinnest manual working volume per axis (normalized): about one cell on a 100-cell axis. */
const MIN_THICKNESS = 0.01;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function newBounds() {
  return { x0: 1, x1: 0, y0: 1, y1: 0, z0: 1, z1: 0, raw: { ...FULL } };
}

/**
 * Cells of slack added around EVERY feature box (independent of the normalized padding):
 * covers the node snapping of feature centres (±0.5 cell), element-vs-node offsets and the
 * rounding of the bounds to whole elements, so no boss / foot / wall is ever clipped by
 * the working-volume edge even with padding 0.
 */
export const AUTO_SAFETY_CELLS = 1.5;

/** Grow bounds by a box: centre (normalized) ± half-extents (cells). */
function addBox(b, dims, cx, cy, cz, hxC0, hyC0, hzC0, grows = false) {
  if (grows) {
    // Raw (margin-free) extent: only used to detect features that overflow the domain.
    const r = b.raw;
    r.x0 = Math.min(r.x0, cx - hxC0 / dims.nx);
    r.x1 = Math.max(r.x1, cx + hxC0 / dims.nx);
    r.y0 = Math.min(r.y0, cy - hyC0 / dims.ny);
    r.y1 = Math.max(r.y1, cy + hyC0 / dims.ny);
    r.z0 = Math.min(r.z0, cz - hzC0 / dims.nz);
    r.z1 = Math.max(r.z1, cz + hzC0 / dims.nz);
  }
  const hxC = hxC0 + AUTO_SAFETY_CELLS;
  const hyC = hyC0 + AUTO_SAFETY_CELLS;
  const hzC = hzC0 + AUTO_SAFETY_CELLS;
  b.x0 = Math.min(b.x0, cx - hxC / dims.nx);
  b.x1 = Math.max(b.x1, cx + hxC / dims.nx);
  b.y0 = Math.min(b.y0, cy - hyC / dims.ny);
  b.y1 = Math.max(b.y1, cy + hyC / dims.ny);
  b.z0 = Math.min(b.z0, cz - hzC / dims.nz);
  b.z1 = Math.max(b.z1, cz + hzC / dims.nz);
}

/**
 * Fit an AABB around every scene feature, incl. bolt bosses, pressure cavities
 * + walls, wall pads, rests and point loads.
 *
 * @param {import('./types.js').Scene | null | undefined} scene
 * @param {number} [padding]
 * @param {{ nx: number, ny: number, nz: number }} [dims]
 * @param {{ grow?: boolean }} [opts]  grow: sides where a pressure cavity (+ wall) pokes out of
 *   the domain are extended past [0,1] instead of clamped (used to resize the domain).
 * @returns {WorkingBounds}
 */
export function computeAutoWorkingBounds(scene, padding = 0.06, dims = DEFAULT_DIMS, opts = {}) {
  const feats = orderedFeatures(scene).filter(Boolean);
  if (!feats.length) return { ...FULL };

  const b = newBounds();
  let any = false;

  for (const f of feats) {
    const box = componentDef(f.type)?.extent?.(f, dims);
    if (!box) continue;
    any = true;
    addBox(b, dims, box.cx, box.cy, box.cz, box.hx, box.hy, box.hz, !!box.grows);
  }

  if (!any) return { ...FULL };

  const pad = Math.max(0, padding);
  const nA = { x: dims.nx, y: dims.ny, z: dims.nz };
  const side = (k, hi) => {
    const key = k + (hi ? '1' : '0');
    const raw = b.raw[key];
    const over = hi ? raw > 1 + 1e-9 : raw < -1e-9;
    if (opts.grow && over) {
      const m = AUTO_SAFETY_CELLS / nA[k] + pad;
      return hi ? raw + m : raw - m;
    }
    return clamp01(hi ? b[key] + pad : b[key] - pad);
  };
  return {
    x0: side('x', false),
    x1: side('x', true),
    y0: side('y', false),
    y1: side('y', true),
    z0: side('z', false),
    z1: side('z', true),
  };
}

/**
 * Per-side overflow (in cells) of pressure cavities + walls beyond the FEA domain
 * (the domain is too small to hold them). Null when everything fits.
 * @returns {{ x0: number, x1: number, y0: number, y1: number, z0: number, z1: number } | null}
 */
export function pressureOverflowCells(scene, dims = DEFAULT_DIMS) {
  const b = newBounds();
  for (const f of orderedFeatures(scene)) {
    if (!f) continue;
    const box = componentDef(f.type)?.extent?.(f, dims);
    if (!box?.grows) continue;
    addBox(b, dims, box.cx, box.cy, box.cz, box.hx, box.hy, box.hz, true);
  }
  const r = b.raw;
  const o = {
    x0: Math.max(0, -r.x0 * dims.nx),
    x1: Math.max(0, (r.x1 - 1) * dims.nx),
    y0: Math.max(0, -r.y0 * dims.ny),
    y1: Math.max(0, (r.y1 - 1) * dims.ny),
    z0: Math.max(0, -r.z0 * dims.nz),
    z1: Math.max(0, (r.z1 - 1) * dims.nz),
  };
  return Object.values(o).some((v) => v > 0.01) ? o : null;
}

/**
 * Bounds the domain should be resized to (may extend past [0,1]):
 *  auto   → box around the objects; pressure cavities that overflow grow the box;
 *  manual → the manual box;
 *  full   → the domain, grown only where a pressure cavity pokes out.
 */
export function resolveFitBounds(scene, dims = DEFAULT_DIMS) {
  const wv = scene?.workingVolume;
  if (wv?.mode === 'manual' && wv.bounds) return sanitizeFreeBounds(wv.bounds);
  if (wv?.mode === 'auto') return computeAutoWorkingBounds(scene, wv.padding ?? 0.06, dims, { grow: true });
  const o = pressureOverflowCells(scene, dims);
  if (!o) return { ...FULL };
  const m = (c, n) => (c > 0 ? (c + AUTO_SAFETY_CELLS) / n : 0);
  return {
    x0: -m(o.x0, dims.nx),
    x1: 1 + m(o.x1, dims.nx),
    y0: -m(o.y0, dims.ny),
    y1: 1 + m(o.y1, dims.ny),
    z0: -m(o.z0, dims.nz),
    z1: 1 + m(o.z1, dims.nz),
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
    if (hi - lo >= MIN_THICKNESS) return [lo, hi];
    const m = 0.5 * (lo + hi);
    return [clamp01(m - MIN_THICKNESS / 2), clamp01(m + MIN_THICKNESS / 2)];
  };
  [x0, x1] = thin(x0, x1);
  [y0, y1] = thin(y0, y1);
  [z0, z1] = thin(z0, z1);
  return { x0, x1, y0, y1, z0, z1 };
}

/**
 * Like sanitizeBounds but the box may extend past the domain (it is only used to resize the
 * domain): ordered, finite, at least MIN_THICKNESS thick.
 * @param {WorkingBounds} b
 */
export function sanitizeFreeBounds(b) {
  const g = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const axis = (lo0, hi0) => {
    let lo = g(lo0, 0);
    let hi = g(hi0, 1);
    if (hi < lo) [lo, hi] = [hi, lo];
    if (hi - lo < MIN_THICKNESS) {
      const m = 0.5 * (lo + hi);
      lo = m - MIN_THICKNESS / 2;
      hi = m + MIN_THICKNESS / 2;
    }
    return [lo, hi];
  };
  const [x0, x1] = axis(b.x0, b.x1);
  const [y0, y1] = axis(b.y0, b.y1);
  const [z0, z1] = axis(b.z0, b.z1);
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
