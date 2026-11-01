import {
  holeAxialRange,
  holeFrame,
  holeSpan,
  sphereInterfaceNodes,
  toXYZ,
  validAxis,
} from '../geometry.js';
import {
  clampActive,
  clampSides,
  forClosedSurfaceNodes,
  forOpenSurfaceNodes,
  ngonMetric,
  normToNodeIndices,
  shellRadii,
} from '../tools.js';
import { applyFixFlags, num } from './shared.js';

/**
 * Open tube: outer-only fills the core and clamps the skin.
 * Inner and both leave the bore void and clamp the surfaces named by `active`.
 * Closed shell: same radii, plus caps. A sphere ignores the axis.
 */

function metricOf(profile, n, rotation) {
  if (profile === 'prism') return (du, dv) => ngonMetric(du, dv, n, rotation);
  return (du, dv) => Math.hypot(du, dv);
}

function openFrame(c, ctx) {
  const frame = holeFrame(c, ctx.dims);
  const range = holeAxialRange(c, ctx.wb, frame.axis, frame.nA);
  if (!range) return null;
  const radii = shellRadii(c.radius, c.wall, ctx.maxDim);
  const metric = metricOf(c.profile === 'prism' ? 'prism' : 'cylinder', c.n, c.rotation);
  return { frame, range, radii, metric, active: clampActive(c.active) };
}

function elementOffset(axis, ex, ey, ez, i1, i2) {
  if (axis === 'x') return { du: ey + 0.5 - i1, dv: ez + 0.5 - i2, a: ex };
  if (axis === 'y') return { du: ex + 0.5 - i1, dv: ez + 0.5 - i2, a: ey };
  return { du: ex + 0.5 - i1, dv: ey + 0.5 - i2, a: ez };
}

/** @param {'solid'|'void'} slot */
function paintOpen(c, ctx, slot) {
  const shell = openFrame(c, ctx);
  if (!shell) return;
  const { frame, range, radii, metric, active } = shell;
  const hollow = active !== 'outer';
  if (slot === 'void' && !hollow) return;
  if (slot === 'solid' && c.solid === false) return;
  const { Rin, Rout } = radii;
  const r = Math.ceil(Rout) + 1;
  const xyz = [0, 0, 0];
  const target = slot === 'void' ? ctx.voidm : ctx.solid;
  for (let a = range[0]; a <= range[1]; a++) {
    for (let e2 = Math.max(0, frame.i2 - r); e2 < Math.min(frame.n2, frame.i2 + r); e2++) {
      for (let e1 = Math.max(0, frame.i1 - r); e1 < Math.min(frame.n1, frame.i1 + r); e1++) {
        const m = metric(e1 + 0.5 - frame.i1, e2 + 0.5 - frame.i2);
        const bore = m <= Rin;
        const body = m <= Rout;
        const on = slot === 'void' ? bore : hollow ? body && !bore : body;
        if (!on) continue;
        toXYZ(frame.axis, e1, e2, a, xyz);
        target[ctx.E(xyz[0], xyz[1], xyz[2])] = 1;
        ctx.any = true;
      }
    }
  }
}

export function paintOpenSolid(c, ctx) {
  paintOpen(c, ctx, 'solid');
}

export function paintOpenVoid(c, ctx) {
  paintOpen(c, ctx, 'void');
}

export function fixOpenShell(c, ctx) {
  const shell = openFrame(c, ctx);
  if (!shell) {
    if (c.fixX !== false || c.fixY !== false || c.fixZ !== false) {
      ctx.warnings?.push?.(`${c.id} is outside the working volume.`);
    }
    return;
  }
  const { frame, range, radii, metric, active } = shell;
  const { nx, ny, nz } = ctx.dims;
  /** @type {Set<number>} */
  const seen = new Set();
  const take = (R) => {
    forOpenSurfaceNodes(
      nx, ny, nz, frame.axis, frame.i1, frame.i2, frame.n1, frame.n2,
      range[0], range[1], R, metric,
      (ix, iy, iz) => {
        const n = ctx.idx(ix, iy, iz);
        if (seen.has(n)) return;
        seen.add(n);
        applyFixFlags(c, ctx, n);
      },
    );
  };
  if (active !== 'outer') take(radii.Rin);
  if (active !== 'inner') take(radii.Rout);
}

function spherePack(c, ctx) {
  const p = normToNodeIndices(ctx.dims.nx, ctx.dims.ny, ctx.dims.nz, c.x, c.y, c.z);
  const radii = shellRadii(c.radius, c.wall, ctx.maxDim);
  return { p, radii, active: clampActive(c.active) };
}

function sphereDist2(ex, ey, ez, p) {
  const dx = ex + 0.5 - p.ix;
  const dy = ey + 0.5 - p.iy;
  const dz = ez + 0.5 - p.iz;
  return dx * dx + dy * dy + dz * dz;
}

export function paintSphereSolid(c, ctx) {
  if (c.solid === false) return;
  const { p, radii, active } = spherePack(c, ctx);
  const { nx, ny, nz } = ctx.dims;
  const { Rin, Rout } = radii;
  const hollow = active !== 'outer';
  const r = Math.ceil(Rout) + 1;
  const Rin2 = Rin * Rin + 1e-9;
  const Rout2 = Rout * Rout + 1e-9;
  for (let ez = Math.max(0, p.iz - r); ez < Math.min(nz, p.iz + r); ez++) {
    for (let ey = Math.max(0, p.iy - r); ey < Math.min(ny, p.iy + r); ey++) {
      for (let ex = Math.max(0, p.ix - r); ex < Math.min(nx, p.ix + r); ex++) {
        const d2 = sphereDist2(ex, ey, ez, p);
        const bore = d2 <= Rin2;
        const body = d2 <= Rout2;
        if (!(hollow ? body && !bore : body)) continue;
        ctx.solid[ctx.E(ex, ey, ez)] = 1;
        ctx.any = true;
      }
    }
  }
}

export function paintSphereVoid(c, ctx) {
  const { p, radii, active } = spherePack(c, ctx);
  if (active === 'outer') return;
  const { nx, ny, nz } = ctx.dims;
  const Rin2 = radii.Rin * radii.Rin + 1e-9;
  const r = Math.ceil(radii.Rin) + 1;
  for (let ez = Math.max(0, p.iz - r); ez < Math.min(nz, p.iz + r); ez++) {
    for (let ey = Math.max(0, p.iy - r); ey < Math.min(ny, p.iy + r); ey++) {
      for (let ex = Math.max(0, p.ix - r); ex < Math.min(nx, p.ix + r); ex++) {
        if (sphereDist2(ex, ey, ez, p) > Rin2) continue;
        ctx.voidm[ctx.E(ex, ey, ez)] = 1;
        ctx.any = true;
      }
    }
  }
}

export function fixSphereShell(c, ctx) {
  const { p, radii, active } = spherePack(c, ctx);
  /** @type {Set<number>} */
  const seen = new Set();
  const take = (R) => {
    sphereInterfaceNodes(ctx.dims, p, R, (ix, iy, iz) => {
      const n = ctx.idx(ix, iy, iz);
      if (seen.has(n)) return;
      seen.add(n);
      applyFixFlags(c, ctx, n);
    });
  };
  if (active !== 'outer') take(radii.Rin);
  if (active !== 'inner') take(radii.Rout);
}

/**
 * Closed prism or closed cylinder. The cavity is the outer body inset by `wall`
 * cells on the ends and by `Rin` on the sides. No cavity when the span is shorter
 * than the two caps.
 */
export function closedTube(c, ctx) {
  const frame = holeFrame(c, ctx.dims);
  const range = holeAxialRange(c, ctx.wb, frame.axis, frame.nA);
  if (!range) return null;
  const radii = shellRadii(c.radius, c.wall, ctx.maxDim);
  const [e0, e1] = range;
  const inner0 = e0 + radii.wall;
  const inner1 = e1 - radii.wall;
  const metric = metricOf(c.profile === 'cylinder' ? 'cylinder' : 'prism', c.n, c.rotation);
  return {
    frame,
    e0,
    e1,
    inner0,
    inner1,
    hasCavity: inner1 >= inner0,
    radii,
    metric,
    active: clampActive(c.active),
  };
}

function tubeClass(tube, ex, ey, ez) {
  const { frame, metric } = tube;
  const o = elementOffset(frame.axis, ex, ey, ez, frame.i1, frame.i2);
  const m = metric(o.du, o.dv);
  const inOuter = o.a >= tube.e0 && o.a <= tube.e1 && m <= tube.radii.Rout;
  const inInner = tube.hasCavity && o.a >= tube.inner0 && o.a <= tube.inner1 && m <= tube.radii.Rin;
  return { inOuter, inInner };
}

function tubeBox(tube, dims) {
  const { frame, radii, e0, e1 } = tube;
  const r = Math.ceil(radii.Rout) + 2;
  const box = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
  const put = (axis, a0, a1, p0, p1) => {
    if (axis === 'x') {
      box.x0 = a0; box.x1 = a1; box.y0 = p0; box.y1 = p1; box.z0 = frame.i2 - r; box.z1 = frame.i2 + r;
    } else if (axis === 'y') {
      box.y0 = a0; box.y1 = a1; box.x0 = p0; box.x1 = p1; box.z0 = frame.i2 - r; box.z1 = frame.i2 + r;
    } else {
      box.z0 = a0; box.z1 = a1; box.x0 = p0; box.x1 = p1; box.y0 = frame.i2 - r; box.y1 = frame.i2 + r;
    }
  };
  put(frame.axis, e0 - 1, e1 + 1, frame.i1 - r, frame.i1 + r);
  box.x0 = Math.max(0, box.x0);
  box.y0 = Math.max(0, box.y0);
  box.z0 = Math.max(0, box.z0);
  box.x1 = Math.min(dims.nx - 1, box.x1);
  box.y1 = Math.min(dims.ny - 1, box.y1);
  box.z1 = Math.min(dims.nz - 1, box.z1);
  return box;
}

function paintTube(c, ctx, slot) {
  const tube = closedTube(c, ctx);
  if (!tube) return;
  const hollow = tube.active !== 'outer' && tube.hasCavity;
  if (slot === 'void' && !hollow) return;
  if (slot === 'solid' && c.solid === false) return;
  const box = tubeBox(tube, ctx.dims);
  const target = slot === 'void' ? ctx.voidm : ctx.solid;
  for (let ez = box.z0; ez <= box.z1; ez++) {
    for (let ey = box.y0; ey <= box.y1; ey++) {
      for (let ex = box.x0; ex <= box.x1; ex++) {
        const { inOuter, inInner } = tubeClass(tube, ex, ey, ez);
        const on = slot === 'void' ? inInner : hollow ? inOuter && !inInner : inOuter;
        if (!on) continue;
        target[ctx.E(ex, ey, ez)] = 1;
        ctx.any = true;
      }
    }
  }
}

export function paintTubeSolid(c, ctx) {
  paintTube(c, ctx, 'solid');
}

export function paintTubeVoid(c, ctx) {
  paintTube(c, ctx, 'void');
}

export function fixTubeShell(c, ctx) {
  const tube = closedTube(c, ctx);
  if (!tube) {
    ctx.warnings?.push?.(`${c.id} is outside the working volume.`);
    return;
  }
  const { nx, ny, nz } = ctx.dims;
  const box = tubeBox(tube, ctx.dims);
  /** @type {Set<number>} */
  const seen = new Set();
  const take = (which) => {
    forClosedSurfaceNodes(nx, ny, nz, box, (ex, ey, ez) => {
      const cls = tubeClass(tube, ex, ey, ez);
      return which === 'inner' ? cls.inInner : cls.inOuter;
    }, (ix, iy, iz) => {
      const n = ctx.idx(ix, iy, iz);
      if (seen.has(n)) return;
      seen.add(n);
      applyFixFlags(c, ctx, n);
    });
  };
  const hollow = tube.active !== 'outer' && tube.hasCavity;
  if (hollow) take('inner');
  if (tube.active !== 'inner' || !hollow) take('outer');
}

/** Outward unit normal at a cavity-wall node (solid centroid minus void centroid). */
export function cavityNodeNormal(tube, nx, ny, nz, ix, iy, iz) {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  let ns = 0;
  let nv = 0;
  for (let ez = iz - 1; ez <= iz; ez++) {
    if (ez < 0 || ez >= nz) continue;
    for (let ey = iy - 1; ey <= iy; ey++) {
      if (ey < 0 || ey >= ny) continue;
      for (let ex = ix - 1; ex <= ix; ex++) {
        if (ex < 0 || ex >= nx) continue;
        const { inInner } = tubeClass(tube, ex, ey, ez);
        if (inInner) {
          vx += ex + 0.5;
          vy += ey + 0.5;
          vz += ez + 0.5;
          nv++;
        } else {
          sx += ex + 0.5;
          sy += ey + 0.5;
          sz += ez + 0.5;
          ns++;
        }
      }
    }
  }
  if (!nv || !ns) return null;
  const x = sx / ns - vx / nv;
  const y = sy / ns - vy / nv;
  const z = sz / ns - vz / nv;
  const l = Math.hypot(x, y, z);
  if (l < 1e-9) return null;
  return [x / l, y / l, z / l];
}

export function forCavityNodes(c, ctx, cb) {
  const tube = closedTube({ ...c, profile: 'cylinder', active: 'inner' }, ctx);
  if (!tube || !tube.hasCavity) return null;
  const { nx, ny, nz } = ctx.dims;
  const box = tubeBox(tube, ctx.dims);
  forClosedSurfaceNodes(nx, ny, nz, box, (ex, ey, ez) => tubeClass(tube, ex, ey, ez).inInner, (ix, iy, iz) => {
    cb(ix, iy, iz, tube);
  });
  return tube;
}

export function shellExtent(c, dims, profile) {
  const maxDim = Math.max(dims.nx, dims.ny, dims.nz);
  const { Rout } = shellRadii(c.radius, c.wall, maxDim);
  const cen = { x: num(c.x, 0.5), y: num(c.y, 0.5), z: num(c.z, 0.5) };
  if (profile === 'sphere') {
    return { cx: cen.x, cy: cen.y, cz: cen.z, hx: Rout, hy: Rout, hz: Rout };
  }
  const nOf = { x: dims.nx, y: dims.ny, z: dims.nz };
  const axis = validAxis(c.axis);
  const [lo, hi] = holeSpan(c);
  cen[axis] = (lo + hi) / 2;
  const half = { x: Rout, y: Rout, z: Rout };
  half[axis] = ((hi - lo) / 2) * nOf[axis];
  return { cx: cen.x, cy: cen.y, cz: cen.z, hx: half.x, hy: half.y, hz: half.z };
}

export function shellGlyph(c, dims, wb, profile) {
  const maxDim = Math.max(dims.nx, dims.ny, dims.nz);
  const { Rin, Rout } = shellRadii(c.radius, c.wall, maxDim);
  const p = normToNodeIndices(dims.nx, dims.ny, dims.nz, c.x, c.y, c.z);
  const axis = validAxis(c.axis);
  const nA = axis === 'x' ? dims.nx : axis === 'y' ? dims.ny : dims.nz;
  const range = profile === 'sphere' ? null : (holeAxialRange(c, wb, axis, nA) ?? [0, nA - 1]);
  return {
    kind: 'shell',
    id: c.id,
    ix: p.ix,
    iy: p.iy,
    iz: p.iz,
    profile: profile === 'sphere' ? 'sphere' : profile === 'cylinder' ? 'cylinder' : 'prism',
    axis,
    a0: range ? range[0] : undefined,
    a1: range ? range[1] + 1 : undefined,
    radiusIn: Rin,
    radiusOut: Rout,
    active: clampActive(c.active),
    n: profile === 'prism' ? clampSides(c.n) : undefined,
    rotation: profile === 'prism' ? (Number.isFinite(c.rotation) ? c.rotation : 0) : undefined,
  };
}

export function normalizeRadial(c, { prism = false } = {}) {
  c.axis = validAxis(c.axis);
  c.active = clampActive(c.active);
  if (!Number.isFinite(c.radius)) c.radius = 0.15;
  c.radius = Math.max(0, c.radius);
  c.wall = Math.max(2, Math.min(12, Math.round(Number.isFinite(c.wall) ? c.wall : 2)));
  if (c.solid == null) c.solid = true;
  if (!Number.isFinite(c.len)) c.len = 1;
  c.len = Math.min(1, Math.max(0.05, c.len));
  if (prism) {
    c.n = clampSides(c.n);
    const tau = Math.PI * 2;
    const rot = Number.isFinite(c.rotation) ? c.rotation : 0;
    c.rotation = ((rot % tau) + tau) % tau;
  }
}

export function cropRadial(c, ctx) {
  if (Number.isFinite(c.radius)) c.radius *= ctx.radiusK;
  const axis = validAxis(c.axis);
  if (Number.isFinite(c.len)) c.len = Math.min(1, Math.max(0.02, c.len / ctx.range[axis]));
}
