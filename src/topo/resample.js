/**
 * Density-field transfer between grids (used by the Stage Optimizer to warm-start a
 * finer mesh from the result on a coarser one).
 *
 * Elements are indexed `ex + nx * (ey + ny * ez)`; element centres sit at (i + 0.5) / n
 * in normalised coordinates, so the transfer is cell-centred and the domain stays aligned.
 */

const XMIN = 0.001;

const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Trilinear (cell-centred) resample of an element field.
 *
 * @param {ArrayLike<number>} src
 * @param {number} sx @param {number} sy @param {number} sz  source grid
 * @param {number} dx @param {number} dy @param {number} dz  destination grid
 * @returns {Float32Array}
 */
export function resampleDensity(src, sx, sy, sz, dx, dy, dz) {
  const out = new Float32Array(dx * dy * dz);
  if (sx === dx && sy === dy && sz === dz) {
    out.set(src);
    return out;
  }
  const fx = sx / dx;
  const fy = sy / dy;
  const fz = sz / dz;

  // Precompute per-axis sample indices / weights.
  const axis = (n, sn, f) => {
    const i0 = new Int32Array(n);
    const i1 = new Int32Array(n);
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const g = (i + 0.5) * f - 0.5;
      const f0 = Math.floor(g);
      i0[i] = clampI(f0, 0, sn - 1);
      i1[i] = clampI(f0 + 1, 0, sn - 1);
      t[i] = Math.min(1, Math.max(0, g - f0));
    }
    return { i0, i1, t };
  };
  const X = axis(dx, sx, fx);
  const Y = axis(dy, sy, fy);
  const Z = axis(dz, sz, fz);

  let o = 0;
  for (let k = 0; k < dz; k++) {
    const z0 = Z.i0[k] * sx * sy;
    const z1 = Z.i1[k] * sx * sy;
    const tz = Z.t[k];
    for (let j = 0; j < dy; j++) {
      const y0 = Y.i0[j] * sx;
      const y1 = Y.i1[j] * sx;
      const ty = Y.t[j];
      for (let i = 0; i < dx; i++, o++) {
        const x0 = X.i0[i];
        const x1 = X.i1[i];
        const tx = X.t[i];
        const c00 = src[z0 + y0 + x0] * (1 - tx) + src[z0 + y0 + x1] * tx;
        const c10 = src[z0 + y1 + x0] * (1 - tx) + src[z0 + y1 + x1] * tx;
        const c01 = src[z1 + y0 + x0] * (1 - tx) + src[z1 + y0 + x1] * tx;
        const c11 = src[z1 + y1 + x0] * (1 - tx) + src[z1 + y1 + x1] * tx;
        out[o] = (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
      }
    }
  }
  return out;
}

/**
 * Grid dimensions with (approximately) `targetVoxels` elements that keep the aspect
 * ratio of `base` (a cell is one world unit, so the aspect IS the physical shape).
 *
 * @param {{ nx: number, ny: number, nz: number }} base
 * @param {number} targetVoxels
 * @returns {{ nx: number, ny: number, nz: number, total: number }}
 */
export function dimsForVoxelTarget(base, targetVoxels) {
  const baseTotal = base.nx * base.ny * base.nz;
  const s = Math.cbrt(Math.max(1, targetVoxels) / baseTotal);
  const nx = Math.max(4, Math.round(base.nx * s));
  const ny = Math.max(4, Math.round(base.ny * s));
  const nz = Math.max(4, Math.round(base.nz * s));
  return { nx, ny, nz, total: nx * ny * nz };
}

/**
 * Seed solver density fields (x, xPhys) from a previous-grid result.
 *
 * `sharpen` ∈ [0,1] re-contrasts the interpolated edges (trilinear blurs the 0/1
 * boundary): gain = 1 + 2·sharpen about ρ = 0.5. The OC update restores the volume
 * fraction within the first iterations, so a mild value is safe.
 *
 * @param {Float32Array} x
 * @param {Float32Array} xPhys
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {{ nx: number, ny: number, nz: number, data: ArrayLike<number>, sharpen?: number } | null | undefined} init
 * @returns {boolean} true if the field was seeded
 */
export function seedDensity(x, xPhys, nx, ny, nz, init) {
  if (!init || !init.data) return false;
  const { nx: sx, ny: sy, nz: sz, data } = init;
  if (!(sx > 0 && sy > 0 && sz > 0) || data.length !== sx * sy * sz) return false;
  const field = resampleDensity(data, sx, sy, sz, nx, ny, nz);
  const sameGrid = sx === nx && sy === ny && sz === nz;
  const gain = sameGrid ? 1 : 1 + 2 * Math.min(1, Math.max(0, init.sharpen ?? 0));
  for (let i = 0; i < field.length; i++) {
    let v = field[i];
    if (gain !== 1) v = 0.5 + (v - 0.5) * gain;
    v = v < XMIN ? XMIN : v > 1 ? 1 : v;
    x[i] = v;
    xPhys[i] = v;
  }
  return true;
}
