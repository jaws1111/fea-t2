/**
 * Shared hole / cavity geometry so BC application, passive regions and the auto
 * working volume all agree on exactly the same elements and nodes.
 *
 * Units: "cells" = grid elements (1 cell = 1 world unit). Normalized scene
 * radii are a FRACTION OF max(nx, ny, nz) — NOT per-axis.
 */

import { normToNodeIndices } from './tools.js';

export const PRESSURE_WALL_CELLS = 2;
/** Smallest bore: the 2×2 elements around the centre node. */
export const MIN_HOLE_R = 0.75;

/** @param {'x'|'y'|'z'} axis */
export function perpAxes(axis) {
  return axis === 'x' ? ['y', 'z'] : axis === 'y' ? ['x', 'z'] : ['x', 'y'];
}

/** @param {any} a */
export function validAxis(a) {
  return a === 'x' || a === 'y' || a === 'z' ? a : 'z';
}

/** Bore radius in cells (never below MIN_HOLE_R so a void always exists). */
export function holeRadiusCells(radiusNorm, maxDim) {
  const r = Number.isFinite(radiusNorm) ? radiusNorm : 0.04;
  return Math.max(MIN_HOLE_R, Math.max(0.02, r) * maxDim);
}

/** Outer radius of the locked solid boss (washer / sleeve) around a bore. */
export function holeBossOuterCells(Rvoid) {
  return Rvoid + Math.max(2.5, Rvoid * 1.25);
}

/** Sphere cavity radius in cells (min 1.5 so interior elements exist). */
export function sphereRadiusCells(radiusNorm, maxDim) {
  const r = Number.isFinite(radiusNorm) ? radiusNorm : 0.12;
  return Math.max(1.5, r * maxDim);
}

/**
 * Hole frame: which indices are perpendicular, centre node in the perp plane.
 * @param {{ axis?: string, x: number, y: number, z: number }} f
 * @param {{ nx: number, ny: number, nz: number }} dims
 */
export function holeFrame(f, dims) {
  const axis = validAxis(f.axis);
  const [pa, pb] = perpAxes(axis);
  const c = normToNodeIndices(dims.nx, dims.ny, dims.nz, f.x, f.y, f.z);
  const n = { x: dims.nx, y: dims.ny, z: dims.nz };
  const i = { x: c.ix, y: c.iy, z: c.iz };
  return {
    axis,
    perp: [pa, pb],
    n1: n[pa],
    n2: n[pb],
    nA: n[axis],
    i1: i[pa],
    i2: i[pb],
  };
}

/** Map (axis, perp1, perp2, axial) node indices → [ix, iy, iz]. */
export function toXYZ(axis, p1, p2, a, out = [0, 0, 0]) {
  if (axis === 'x') {
    out[0] = a;
    out[1] = p1;
    out[2] = p2;
  } else if (axis === 'y') {
    out[0] = p1;
    out[1] = a;
    out[2] = p2;
  } else {
    out[0] = p1;
    out[1] = p2;
    out[2] = a;
  }
  return out;
}

/** In-plane unit-less radial vector in 3D for offsets (u along perp[0], v along perp[1]). */
export function radial3(axis, u, v) {
  if (axis === 'x') return [0, u, v];
  if (axis === 'y') return [u, 0, v];
  return [u, v, 0];
}

/** Right-handed tangent: axisUnit × r. */
export function tangent3(axis, r) {
  const [rx, ry, rz] = r;
  if (axis === 'x') return [0, -rz, ry]; // x̂ × r
  if (axis === 'y') return [rz, 0, -rx]; // ŷ × r
  return [-ry, rx, 0]; // ẑ × r
}

/**
 * Element index range [e0, e1] along an axis for a normalized span [s0, s1]
 * (element centre inside the span). Always returns at least one element.
 */
export function axialElementRange(s0, s1, nA) {
  const lo = Math.min(s0, s1) * nA;
  const hi = Math.max(s0, s1) * nA;
  const e0 = Math.max(0, Math.ceil(lo - 0.5));
  const e1 = Math.min(nA - 1, Math.floor(hi - 0.5));
  if (e1 >= e0) return [e0, e1];
  const m = Math.min(nA - 1, Math.max(0, Math.round((lo + hi) / 2 - 0.5)));
  return [m, m];
}

/**
 * Axial element range of a hole, clipped to the working volume.
 * @returns {[number, number] | null} null if the hole lies outside the volume
 */
export function holeAxialRange(f, wb, axis, nA) {
  const w0 = wb ? wb[`${axis}0`] : 0;
  const w1 = wb ? wb[`${axis}1`] : 1;
  const [h0, h1] = holeSpan(f);
  const s0 = Math.max(h0, w0);
  const s1 = Math.min(h1, w1);
  if (s1 <= s0) return null;
  return axialElementRange(s0, s1, nA);
}

/** Default bore length as a fraction of the domain along its axis. */
export const DEFAULT_HOLE_LEN = 0.25;

/**
 * Axial extent [s0, s1] (normalized) of a bolt hole: `len` (user-defined length, fraction
 * of the axis) centred on the hole's own coordinate along its axis. Independent of the
 * domain size, so a short pin in a large volume stays short.
 * @param {{ axis?: string, len?: number, x: number, y: number, z: number }} f
 * @returns {[number, number]}
 */
export function holeSpan(f) {
  const axis = validAxis(f.axis);
  const c0 = f[axis];
  const c = Number.isFinite(c0) ? c0 : 0.5;
  const len = Math.min(1, Math.max(0.01, Number.isFinite(f.len) ? f.len : DEFAULT_HOLE_LEN));
  return [Math.max(0, c - len / 2), Math.min(1, c + len / 2)];
}

/**
 * 2D ring of nodes on the bore wall: nodes touching BOTH a void element (centre
 * within Rvoid of the hole axis) and a non-void element. Guarantees every loaded
 * / fixed node is attached to solid boss material.
 *
 * @returns {{ p1: number, p2: number, u: number, v: number }[]}
 */
export function holeInterfaceNodes2D(frame, Rvoid) {
  const { n1, n2, i1, i2 } = frame;
  const R2 = Rvoid * Rvoid + 1e-9;
  const r = Math.ceil(Rvoid) + 2;
  const out = [];
  for (let p2 = Math.max(0, i2 - r); p2 <= Math.min(n2, i2 + r); p2++) {
    for (let p1 = Math.max(0, i1 - r); p1 <= Math.min(n1, i1 + r); p1++) {
      let hasVoid = false;
      let hasSolid = false;
      for (let e2 = p2 - 1; e2 <= p2; e2++) {
        if (e2 < 0 || e2 >= n2) continue;
        for (let e1 = p1 - 1; e1 <= p1; e1++) {
          if (e1 < 0 || e1 >= n1) continue;
          const d2 = (e1 + 0.5 - i1) ** 2 + (e2 + 0.5 - i2) ** 2;
          if (d2 <= R2) hasVoid = true;
          else hasSolid = true;
        }
      }
      if (hasVoid && hasSolid) out.push({ p1, p2, u: p1 - i1, v: p2 - i2 });
    }
  }
  return out;
}

/**
 * Nodes on a spherical cavity wall (touch void interior AND solid wall elements).
 * @param {(ix:number, iy:number, iz:number) => void} cb
 */
export function sphereInterfaceNodes(dims, c, R, cb) {
  const { nx, ny, nz } = dims;
  const R2 = R * R + 1e-9;
  const r = Math.ceil(R) + 2;
  for (let iz = Math.max(0, c.iz - r); iz <= Math.min(nz, c.iz + r); iz++) {
    for (let iy = Math.max(0, c.iy - r); iy <= Math.min(ny, c.iy + r); iy++) {
      for (let ix = Math.max(0, c.ix - r); ix <= Math.min(nx, c.ix + r); ix++) {
        let hasVoid = false;
        let hasSolid = false;
        for (let ez = iz - 1; ez <= iz; ez++) {
          if (ez < 0 || ez >= nz) continue;
          for (let ey = iy - 1; ey <= iy; ey++) {
            if (ey < 0 || ey >= ny) continue;
            for (let ex = ix - 1; ex <= ix; ex++) {
              if (ex < 0 || ex >= nx) continue;
              const d2 =
                (ex + 0.5 - c.ix) ** 2 + (ey + 0.5 - c.iy) ** 2 + (ez + 0.5 - c.iz) ** 2;
              if (d2 <= R2) hasVoid = true;
              else hasSolid = true;
            }
          }
        }
        if (hasVoid && hasSolid) cb(ix, iy, iz);
      }
    }
  }
}

/** Half-extents of a box cavity in whole cells (≥1). */
export function boxHalfCells(f, dims) {
  return {
    rx: Math.max(1, Math.round(Math.abs(f.hx ?? 0.1) * dims.nx)),
    ry: Math.max(1, Math.round(Math.abs(f.hy ?? 0.1) * dims.ny)),
    rz: Math.max(1, Math.round(Math.abs(f.hz ?? 0.1) * dims.nz)),
  };
}

/** Pressure wall thickness (cells) for a pressure feature. */
export function pressureWallCells(f) {
  const w = Number(f.wall);
  return Number.isFinite(w) ? Math.max(1, Math.min(6, Math.round(w))) : PRESSURE_WALL_CELLS;
}

/**
 * Extent of a pressure cavity incl. its wall, in cells per axis (half-extents).
 */
export function pressureExtentCells(f, dims) {
  const maxDim = Math.max(dims.nx, dims.ny, dims.nz);
  const wall = pressureWallCells(f) + 1;
  if (f.shape === 'box') {
    const b = boxHalfCells(f, dims);
    return { hx: b.rx + wall, hy: b.ry + wall, hz: b.rz + wall };
  }
  const R = sphereRadiusCells(f.radius, maxDim) + wall;
  return { hx: R, hy: R, hz: R };
}
