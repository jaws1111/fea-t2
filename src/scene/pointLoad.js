/**
 * Multi-axis point loads.
 *
 * A point load has `axes` (1..6) force directions:
 *   1   the classic single force: vector (fx,fy,fz) applied at the node nearest (x,y,z).
 *   2-6 `axesMode` decides how the directions (±X/±Y/±Z, listed in `dirs`) act:
 *
 *     'cases' (default)  SEPARATE LOAD CASES. The point carries |F| along each direction, but
 *                        one at a time: the structure must be stiff for every case and the
 *                        supports react each of them (up AND down, or any direction). The
 *                        optimizer minimises the SUM of the case compliances. Up + down at one
 *                        node simultaneously would cancel, so they are never combined.
 *     'burst'            ALL AT ONCE. Every direction pushes at the same time, each on the node
 *                        `spread` cells out along it (negative |F| pulls inward). Self-balanced:
 *                        needs no support, so the optimizer builds a body around the point.
 *
 * `dirs` uses face codes ('x+', 'x-', ...); an invalid or short list is rebuilt from the force
 * vector (`defaultPointDirs`).
 */

export const POINT_DIRS = Object.freeze(['x+', 'x-', 'y+', 'y-', 'z+', 'z-']);
export const MAX_POINT_AXES = 6;
export const POINT_MODES = Object.freeze(['cases', 'burst']);

/** @returns {'cases'|'burst'} */
export function pointLoadMode(f) {
  return f?.axesMode === 'burst' ? 'burst' : 'cases';
}

/**
 * Number of independent load cases a scene defines (1 = a single solve per iteration).
 * Multi-axis point loads in 'cases' mode contribute one case per axis.
 * @param {{ forces?: any[] } | null | undefined} scene
 */
export function sceneLoadCaseCount(scene) {
  let k = 1;
  for (const f of scene?.forces ?? []) {
    if (f?.type === 'point_load' && pointLoadAxes(f) > 1 && pointLoadMode(f) === 'cases') {
      k = Math.max(k, pointLoadAxes(f));
    }
  }
  return k;
}

/** @param {string} code @returns {[number, number, number]} */
export function dirVector(code) {
  const s = code[1] === '-' ? -1 : 1;
  return [code[0] === 'x' ? s : 0, code[0] === 'y' ? s : 0, code[0] === 'z' ? s : 0];
}

/** @param {any} f @returns {number} 1..6 */
export function pointLoadAxes(f) {
  const n = Math.round(Number(f?.axes));
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_POINT_AXES, n)) : 1;
}

/**
 * Default direction set for `n` axes, seeded by the force vector's dominant axis d:
 * 2 → ±d · 3 → ±d + one lateral · 4 → ±d ±lateral · 5 → … + one more · 6 → all.
 * @returns {string[]}
 */
export function defaultPointDirs(f, n) {
  const v = [Number(f?.fx) || 0, Number(f?.fy) || 0, Number(f?.fz) || 0];
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(v[i]) > Math.abs(v[k]) + 1e-9) k = i;
  const axes = ['x', 'y', 'z'];
  const first = axes[k];
  const sign = v[k] < 0 ? '-' : '+';
  const opposite = sign === '+' ? '-' : '+';
  const others = axes.filter((a) => a !== first);
  const order = [
    first + sign,
    first + opposite,
    others[0] + '+',
    others[0] + '-',
    others[1] + '+',
    others[1] + '-',
  ];
  return order.slice(0, Math.max(1, Math.min(MAX_POINT_AXES, n)));
}

/** Validated direction codes for a multi-axis load (length = `axes`). @returns {string[]} */
export function pointLoadDirs(f) {
  const n = pointLoadAxes(f);
  const given = Array.isArray(f?.dirs) ? [...new Set(f.dirs.filter((d) => POINT_DIRS.includes(d)))] : [];
  if (given.length >= n) return given.slice(0, n);
  // Top up from the defaults, keeping what the user already chose.
  const out = [...given];
  for (const d of defaultPointDirs(f, MAX_POINT_AXES)) {
    if (out.length >= n) break;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** Offset (cells) of a burst's loaded nodes from the point. */
export function pointSpreadCells(f, maxDim) {
  const r = Number(f?.radius);
  return Math.max(1, Math.round((Number.isFinite(r) ? r : 0.04) * maxDim));
}

/**
 * Force components of a point load, in application order.
 * Single axis: one entry at offset 0 with the (signed-by-magnitude) unit vector.
 * 'burst': one entry per direction, offset along that direction by `spread` cells.
 * 'cases': one entry per direction at offset 0; with `loadCase` given only that case's
 *          component (none when the load has fewer axes than the case index).
 *
 * @param {any} f  point_load force
 * @param {number} maxDim
 * @param {number} [loadCase]  restrict a 'cases' load to this case (omit for all, e.g. glyphs)
 * @returns {{ dir: [number, number, number], off: [number, number, number], mag: number }[]}
 */
export function pointLoadComponents(f, maxDim, loadCase) {
  const mag = Number.isFinite(f?.magnitude) ? f.magnitude : 1;
  if (mag === 0) return [];
  const absMag = Math.abs(mag);
  const sgn = mag < 0 ? -1 : 1;
  const n = pointLoadAxes(f);
  if (n === 1) {
    let x = Number(f?.fx) || 0;
    let y = Number(f?.fy) || 0;
    let z = Number(f?.fz) || 0;
    const l = Math.hypot(x, y, z);
    if (l < 1e-12) {
      x = 0;
      y = -1;
      z = 0;
    } else {
      x /= l;
      y /= l;
      z /= l;
    }
    return [{ dir: [sgn * x, sgn * y, sgn * z], off: [0, 0, 0], mag: absMag }];
  }
  if (pointLoadMode(f) === 'cases') {
    const all = pointLoadDirs(f).map((code) => {
      const v = dirVector(code);
      return {
        dir: /** @type {[number, number, number]} */ ([sgn * v[0], sgn * v[1], sgn * v[2]]),
        off: /** @type {[number, number, number]} */ ([0, 0, 0]),
        mag: absMag,
      };
    });
    if (!Number.isInteger(loadCase)) return all;
    return loadCase >= 0 && loadCase < all.length ? [all[loadCase]] : [];
  }
  const spread = pointSpreadCells(f, maxDim);
  return pointLoadDirs(f).map((code) => {
    const v = dirVector(code);
    return {
      dir: /** @type {[number, number, number]} */ ([sgn * v[0], sgn * v[1], sgn * v[2]]),
      off: /** @type {[number, number, number]} */ ([v[0] * spread, v[1] * spread, v[2] * spread]),
      mag: absMag,
    };
  });
}
