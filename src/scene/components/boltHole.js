import {
  holeAxialRange,
  holeBossOuterCells,
  holeFrame,
  holeInterfaceNodes2D,
  holeRadiusCells,
  holeSpan,
  radial3,
  tangent3,
  toXYZ,
  validAxis,
} from '../geometry.js';
import { normToNodeIndices } from '../tools.js';
import { nextId } from './ids.js';
import { anyFix, applyFixFlags, distributeResultant, normalizeDir, num, stripUndefined } from './shared.js';

const BOLT_LOAD_MODES = new Set(['none', 'directional', 'multi', 'circular']);

/** Remove the axis component: perpendicular (in-plane) part of a vector. */
function dropAxis(axis, dx, dy, dz) {
  if (axis === 'x') return [0, dy, dz];
  if (axis === 'y') return [dx, 0, dz];
  return [dx, dy, 0];
}

/**
 * Legacy holes stored an absolute axial span [s0, s1]. The span is now `len` centred on
 * the hole's own coordinate along its axis. Converts in place.
 * @param {Record<string, any>} f
 * @param {boolean} [explicitLen] `len` was supplied by the caller (wins over s0/s1)
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
 * The load vectors a bolt hole carries (signed magnitudes folded into direction).
 * @returns {{ dir: [number, number, number], mag: number }[]}
 */
export function holeLoadVectors(f) {
  const mk = (fx, fy, fz, m) => {
    const mag = Number.isFinite(m) ? m : 1;
    if (mag === 0) return null;
    const d = normalizeDir(fx, fy, fz);
    const s = mag < 0 ? -1 : 1;
    return { dir: /** @type {[number, number, number]} */ ([d[0] * s, d[1] * s, d[2] * s]), mag: Math.abs(mag) };
  };
  if (f.loadMode === 'directional') {
    const v = mk(f.fx, f.fy, f.fz, f.magnitude);
    return v ? [v] : [];
  }
  if (f.loadMode === 'multi') {
    return (f.loads ?? []).map((l) => mk(l.fx, l.fy, l.fz, l.magnitude)).filter(Boolean);
  }
  return [];
}

/**
 * Bore-wall nodes of a hole: [{ n, u, v }] with in-plane offsets from the axis.
 * Empty if the hole lies outside the working volume.
 */
function holeShell(f, ctx) {
  const frame = holeFrame(f, ctx.dims);
  const range = holeAxialRange(f, ctx.wb, frame.axis, frame.nA);
  if (!range) return { frame, nodes: [] };
  const ring = holeInterfaceNodes2D(frame, holeRadiusCells(f.radius, ctx.maxDim));
  const xyz = [0, 0, 0];
  const nodes = [];
  for (let a = range[0]; a <= range[1] + 1; a++) {
    for (const rn of ring) {
      toXYZ(frame.axis, rn.p1, rn.p2, a, xyz);
      nodes.push({ n: ctx.idx(xyz[0], xyz[1], xyz[2]), u: rn.u, v: rn.v });
    }
  }
  return { frame, nodes };
}

function paintCylinder(c, ctx, radiusCells, target) {
  const frame = holeFrame(c, ctx.dims);
  const range = holeAxialRange(c, ctx.wb, frame.axis, frame.nA);
  if (!range) return;
  const R = radiusCells;
  const R2 = R * R + 1e-9;
  const r = Math.ceil(R) + 1;
  const xyz = [0, 0, 0];
  for (let a = range[0]; a <= range[1]; a++) {
    for (let e2 = Math.max(0, frame.i2 - r); e2 < Math.min(frame.n2, frame.i2 + r); e2++) {
      for (let e1 = Math.max(0, frame.i1 - r); e1 < Math.min(frame.n1, frame.i1 + r); e1++) {
        const d2 = (e1 + 0.5 - frame.i1) ** 2 + (e2 + 0.5 - frame.i2) ** 2;
        if (d2 > R2) continue;
        toXYZ(frame.axis, e1, e2, a, xyz);
        target[ctx.E(xyz[0], xyz[1], xyz[2])] = 1;
        ctx.any = true;
      }
    }
  }
}

export const boltHole = {
  type: 'bolt_hole',
  family: 'fixload',
  label: 'Bolt hole',
  icon: 'ph-circle',
  idPrefix: 'bolt',

  create(partial = {}) {
    const base = {
      id: nextId('bolt'),
      type: 'bolt_hole',
      x: 0.5,
      y: 0,
      z: 0.5,
      radius: 0.04,
      axis: 'z',
      len: 0.25,
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
    const out = { ...base, ...stripUndefined(partial), type: 'bolt_hole' };
    migrateHoleSpan(out, Number.isFinite(partial.len));
    return out;
  },

  normalize(c) {
    if (!BOLT_LOAD_MODES.has(c.loadMode)) c.loadMode = 'none';
    if (!Array.isArray(c.loads)) c.loads = [];
    if (!Number.isFinite(c.len) && !Number.isFinite(c.s0) && !Number.isFinite(c.s1)) c.len = 1;
    migrateHoleSpan(c, Number.isFinite(c.len));
    if (c.circMode !== 'radial') c.circMode = 'torque';
    if (!Number.isFinite(c.fx)) c.fx = 0;
    if (!Number.isFinite(c.fy)) c.fy = -1;
    if (!Number.isFinite(c.fz)) c.fz = 0;
    if (!Number.isFinite(c.magnitude)) c.magnitude = 1;
  },

  roles(c) {
    const load = !!c.loadMode && c.loadMode !== 'none';
    return { support: anyFix(c), load };
  },

  fix(c, ctx) {
    if (!anyFix(c)) return;
    for (const nd of holeShell(c, ctx).nodes) applyFixFlags(c, ctx, nd.n);
  },

  load(c, ctx) {
    if (!c.loadMode || c.loadMode === 'none') return;
    const { nodes: shell } = holeShell(c, ctx);
    const axis = validAxis(c.axis);
    if (!shell.length) {
      ctx.warnings.push(`Bolt hole ${c.id} is outside the working volume — its load is ignored.`);
      return;
    }
    const free = [c.fixX === false, c.fixY === false, c.fixZ === false];

    if (c.loadMode === 'circular') {
      const mag = Number.isFinite(c.magnitude) ? c.magnitude : 1;
      if (mag === 0) return;
      const sign = mag < 0 ? -1 : 1;
      const absMag = Math.abs(mag);
      const share = absMag / shell.length;
      let reaches = false;
      for (const nd of shell) {
        const r = radial3(axis, nd.u, nd.v);
        const rl = Math.hypot(r[0], r[1], r[2]);
        if (rl < 1e-9) continue;
        const rhat = [r[0] / rl, r[1] / rl, r[2] / rl];
        const dir = c.circMode === 'radial' ? rhat : tangent3(axis, rhat);
        for (let d = 0; d < 3; d++) {
          ctx.F[3 * nd.n + d] += sign * dir[d] * share;
          if (free[d]) reaches = true;
        }
      }
      ctx.count.loadedNodes += shell.length;
      if (!reaches) ctx.warnings.push(`Bolt hole ${c.id}: circular load is fully absorbed (all axes fixed).`);
      return;
    }

    for (const { dir, mag } of holeLoadVectors(c)) {
      const [px, py, pz] = dropAxis(axis, dir[0], dir[1], dir[2]);
      const pLen = Math.hypot(px, py, pz);
      /** @type {{ n: number, w: number }[]} */
      const nodes = [];
      if (pLen < 1e-6) {
        for (const nd of shell) nodes.push({ n: nd.n, w: 1 });
      } else {
        for (const nd of shell) {
          const r = radial3(axis, nd.u, nd.v);
          const rl = Math.hypot(r[0], r[1], r[2]);
          if (rl < 1e-9) continue;
          const cosT = (r[0] * px + r[1] * py + r[2] * pz) / (rl * pLen);
          if (cosT > 1e-6) nodes.push({ n: nd.n, w: cosT });
        }
        if (!nodes.length) for (const nd of shell) nodes.push({ n: nd.n, w: 1 });
      }
      distributeResultant(ctx.F, nodes, dir, mag);
      ctx.count.loadedNodes += nodes.length;
      let reaches = 0;
      for (let d = 0; d < 3; d++) if (free[d]) reaches += Math.abs(dir[d]);
      if (reaches < 1e-6) {
        ctx.warnings.push(`Bolt hole ${c.id}: a load vector acts only along fixed axes and is absorbed.`);
      }
    }
  },

  paintSolid(c, ctx) {
    const Rvoid = holeRadiusCells(c.radius, ctx.maxDim);
    paintCylinder(c, ctx, holeBossOuterCells(Rvoid), ctx.solid);
  },

  paintVoid(c, ctx) {
    paintCylinder(c, ctx, holeRadiusCells(c.radius, ctx.maxDim), ctx.voidm);
  },

  extent(c, dims) {
    const maxDim = Math.max(dims.nx, dims.ny, dims.nz);
    const nOf = { x: dims.nx, y: dims.ny, z: dims.nz };
    const axis = validAxis(c.axis);
    const Rs = holeBossOuterCells(holeRadiusCells(c.radius, maxDim));
    const half = { x: Rs, y: Rs, z: Rs };
    const [lo, hi] = holeSpan(c);
    const cen = { x: num(c.x, 0.5), y: num(c.y, 0.5), z: num(c.z, 0.5) };
    cen[axis] = (lo + hi) / 2;
    half[axis] = ((hi - lo) / 2) * nOf[axis];
    return { cx: cen.x, cy: cen.y, cz: cen.z, hx: half.x, hy: half.y, hz: half.z };
  },

  crop(c, ctx) {
    if (Number.isFinite(c.radius)) c.radius *= ctx.radiusK;
    if (Number.isFinite(c.len)) {
      const ax = c.axis === 'x' || c.axis === 'y' || c.axis === 'z' ? c.axis : 'z';
      c.len = Math.min(1, c.len / ctx.range[ax]);
    }
  },

  glyphs(c, dims, wb) {
    const { nx, ny, nz } = dims;
    const maxDim = Math.max(nx, ny, nz);
    const p = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
    const axis = validAxis(c.axis);
    const nA = axis === 'x' ? nx : axis === 'y' ? ny : nz;
    const range = holeAxialRange(c, wb, axis, nA) ?? [0, nA - 1];
    const loads = holeLoadVectors(c).map((l) => ({
      dir: { x: l.dir[0], y: l.dir[1], z: l.dir[2] },
      mag: l.mag,
    }));
    const mag = Number.isFinite(c.magnitude) ? c.magnitude : 1;
    return [
      {
        kind: 'bolt',
        id: c.id,
        ix: p.ix,
        iy: p.iy,
        iz: p.iz,
        axis,
        a0: range[0],
        a1: range[1] + 1,
        radius: holeRadiusCells(c.radius, maxDim),
        fixed: { x: c.fixX !== false, y: c.fixY !== false, z: c.fixZ !== false },
        loads,
        circ:
          c.loadMode === 'circular' && mag !== 0
            ? { mode: c.circMode === 'radial' ? 'radial' : 'torque', sign: mag < 0 ? -1 : 1 }
            : undefined,
      },
    ];
  },
};
