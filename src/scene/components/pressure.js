import {
  boxHalfCells,
  pressureExtentCells,
  pressureWallCells,
  sphereInterfaceNodes,
  sphereRadiusCells,
  validAxis,
} from '../geometry.js';
import { forNodesOnBoxShell, forNodesOnSphereShell, normToNodeIndices, shellRadii } from '../tools.js';
import { cavityNodeNormal, forCavityNodes, paintTubeSolid, paintTubeVoid, shellExtent } from './shells.js';
import { nextId } from './ids.js';
import { distributeResultant, normalizeDir, num, stripUndefined, unitDir } from './shared.js';

function paintBox(c, ctx, target, wall) {
  const { nx, ny, nz } = ctx.dims;
  const p = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
  const b = boxHalfCells(c, ctx.dims);
  const extra = wall ?? 0;
  for (let ez = Math.max(0, p.iz - b.rz - extra); ez < Math.min(nz, p.iz + b.rz + extra); ez++) {
    for (let ey = Math.max(0, p.iy - b.ry - extra); ey < Math.min(ny, p.iy + b.ry + extra); ey++) {
      for (let ex = Math.max(0, p.ix - b.rx - extra); ex < Math.min(nx, p.ix + b.rx + extra); ex++) {
        target[ctx.E(ex, ey, ez)] = 1;
        ctx.any = true;
      }
    }
  }
}

function loadCylinder(c, ctx) {
  const mag = Number.isFinite(c.magnitude) ? c.magnitude : 1;
  if (mag === 0) return;
  const absMag = Math.abs(mag);
  const dir = normalizeDir(c.fx, c.fy, c.fz);
  if (mag < 0) {
    dir[0] = -dir[0];
    dir[1] = -dir[1];
    dir[2] = -dir[2];
  }
  const mode = c.pressureMode === 'directional' ? 'directional' : 'radial';
  const sign = (c.inward ? -1 : 1) * (mag < 0 ? -1 : 1);
  const { nx, ny, nz } = ctx.dims;
  /** @type {{ n: number, w: number, nrm: number[] }[]} */
  const nodes = [];
  const spec = { ...c, profile: 'cylinder', len: Number.isFinite(c.len) ? c.len : 0.5 };
  const tube = forCavityNodes(spec, ctx, (ix, iy, iz, built) => {
    const nrm = cavityNodeNormal(built, nx, ny, nz, ix, iy, iz);
    if (!nrm) return;
    let w = 1;
    if (mode === 'directional') {
      w = nrm[0] * dir[0] + nrm[1] * dir[1] + nrm[2] * dir[2];
      if (w <= 1e-6) return;
    }
    nodes.push({ n: ctx.idx(ix, iy, iz), w, nrm });
  });
  if (!tube || nodes.length === 0) {
    ctx.warnings.push(`Pressure ${c.id} cylinder has no cavity wall.`);
    return;
  }
  if (mode === 'directional') {
    distributeResultant(ctx.F, nodes, dir, absMag);
  } else {
    const share = absMag / nodes.length;
    for (const nd of nodes) {
      ctx.F[3 * nd.n] += sign * nd.nrm[0] * share;
      ctx.F[3 * nd.n + 1] += sign * nd.nrm[1] * share;
      ctx.F[3 * nd.n + 2] += sign * nd.nrm[2] * share;
    }
  }
  ctx.count.loadedNodes += nodes.length;
}

function paintSphere(c, ctx, target, outer) {
  const { nx, ny, nz } = ctx.dims;
  const p = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
  const R2 = outer * outer + 1e-9;
  const r = Math.ceil(outer) + 1;
  for (let ez = Math.max(0, p.iz - r); ez < Math.min(nz, p.iz + r); ez++) {
    for (let ey = Math.max(0, p.iy - r); ey < Math.min(ny, p.iy + r); ey++) {
      for (let ex = Math.max(0, p.ix - r); ex < Math.min(nx, p.ix + r); ex++) {
        const d2 = (ex + 0.5 - p.ix) ** 2 + (ey + 0.5 - p.iy) ** 2 + (ez + 0.5 - p.iz) ** 2;
        if (d2 > R2) continue;
        target[ctx.E(ex, ey, ez)] = 1;
        ctx.any = true;
      }
    }
  }
}

export const pressure = {
  type: 'pressure',
  family: 'fixload',
  label: 'Pressure',
  icon: 'ph-waves',
  idPrefix: 'pressure',

  create(partial = {}) {
    const base = {
      id: nextId('pressure'),
      type: 'pressure',
      x: 0.5,
      y: 1,
      z: 0.5,
      fx: 0,
      fy: -1,
      fz: 0,
      magnitude: 1,
      radius: 0.12,
      shape: 'sphere',
      hx: 0.1,
      hy: 0.1,
      hz: 0.1,
      pressureMode: 'radial',
      inward: false,
      cavityVoid: true,
      wall: 2,
    };
    return { ...base, ...stripUndefined(partial), type: 'pressure' };
  },

  normalize(c) {
    if (typeof c.cavityVoid !== 'boolean') c.cavityVoid = true;
    if (!Number.isFinite(c.wall)) c.wall = 2;
    if (c.shape === 'cylinder') {
      c.axis = validAxis(c.axis);
      if (!Number.isFinite(c.len)) c.len = 0.5;
      c.len = Math.min(1, Math.max(0.05, c.len));
    }
  },

  roles() {
    return { support: false, load: true };
  },

  load(c, ctx) {
    if (c.shape === 'cylinder') {
      loadCylinder(c, ctx);
      return;
    }
    const mag = Number.isFinite(c.magnitude) ? c.magnitude : 1;
    if (mag === 0) return;
    const absMag = Math.abs(mag);
    const dir = normalizeDir(c.fx, c.fy, c.fz);
    if (mag < 0) {
      dir[0] = -dir[0];
      dir[1] = -dir[1];
      dir[2] = -dir[2];
    }
    const { nx, ny, nz } = ctx.dims;
    const p = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
    const mode = c.pressureMode === 'directional' ? 'directional' : 'radial';
    const shape = c.shape === 'box' ? 'box' : 'sphere';
    const inwardSign = c.inward ? -1 : 1;
    const useCavity = c.cavityVoid !== false;
    const box = shape === 'box' ? boxHalfCells(c, ctx.dims) : null;

    const outwardNormal = (dx, dy, dz) => {
      let a;
      let b;
      let g;
      if (box) {
        a = Math.abs(dx) === box.rx ? Math.sign(dx) : 0;
        b = Math.abs(dy) === box.ry ? Math.sign(dy) : 0;
        g = Math.abs(dz) === box.rz ? Math.sign(dz) : 0;
      } else {
        a = dx;
        b = dy;
        g = dz;
      }
      const l = Math.hypot(a, b, g);
      if (l < 1e-9) return null;
      return [a / l, b / l, g / l];
    };

    /** @type {{ n: number, w: number, nrm: [number, number, number] }[]} */
    const nodes = [];
    const collect = (ix, iy, iz) => {
      const nrm = outwardNormal(ix - p.ix, iy - p.iy, iz - p.iz);
      if (!nrm) return;
      let w = 1;
      if (mode === 'directional') {
        w = nrm[0] * dir[0] + nrm[1] * dir[1] + nrm[2] * dir[2];
        if (w <= 1e-6) return;
      }
      nodes.push({ n: ctx.idx(ix, iy, iz), w, nrm: /** @type {[number, number, number]} */ (nrm) });
    };

    if (box) {
      forNodesOnBoxShell(nx, ny, nz, c.x, c.y, c.z, c.hx ?? 0.1, c.hy ?? 0.1, c.hz ?? 0.1, collect);
    } else if (useCavity) {
      sphereInterfaceNodes(ctx.dims, p, sphereRadiusCells(c.radius, ctx.maxDim), collect);
    } else {
      forNodesOnSphereShell(nx, ny, nz, c.x, c.y, c.z, c.radius ?? 0.12, collect);
    }

    if (nodes.length === 0) {
      nodes.push({ n: ctx.idx(p.ix, p.iy, p.iz), w: 1, nrm: [dir[0], dir[1], dir[2]] });
    }

    if (mode === 'directional') {
      distributeResultant(ctx.F, nodes, dir, absMag);
    } else {
      const sign = inwardSign * (mag < 0 ? -1 : 1);
      const share = absMag / nodes.length;
      for (const nd of nodes) {
        ctx.F[3 * nd.n] += sign * nd.nrm[0] * share;
        ctx.F[3 * nd.n + 1] += sign * nd.nrm[1] * share;
        ctx.F[3 * nd.n + 2] += sign * nd.nrm[2] * share;
      }
    }
    ctx.count.loadedNodes += nodes.length;
  },

  paintSolid(c, ctx) {
    if (c.cavityVoid === false) return;
    if (c.shape === 'cylinder') {
      paintTubeSolid({ ...c, profile: 'cylinder', active: 'inner', solid: true, len: Number.isFinite(c.len) ? c.len : 0.5 }, ctx);
      return;
    }
    const wall = pressureWallCells(c);
    if (c.shape === 'box') {
      paintBox(c, ctx, ctx.solid, wall);
      return;
    }
    const R = sphereRadiusCells(c.radius, ctx.maxDim);
    paintSphere(c, ctx, ctx.solid, R + wall);
  },

  paintVoid(c, ctx) {
    if (c.cavityVoid === false) return;
    if (c.shape === 'cylinder') {
      paintTubeVoid({ ...c, profile: 'cylinder', active: 'inner', len: Number.isFinite(c.len) ? c.len : 0.5 }, ctx);
      return;
    }
    if (c.shape === 'box') {
      paintBox(c, ctx, ctx.voidm, 0);
      return;
    }
    paintSphere(c, ctx, ctx.voidm, sphereRadiusCells(c.radius, ctx.maxDim));
  },

  extent(c, dims) {
    if (c.shape === 'cylinder') {
      const box = shellExtent({ ...c, len: Number.isFinite(c.len) ? c.len : 0.5 }, dims, 'cylinder');
      box.grows = true;
      return box;
    }
    const e = pressureExtentCells(c, dims);
    return {
      cx: num(c.x, 0.5),
      cy: num(c.y, 0.5),
      cz: num(c.z, 0.5),
      hx: e.hx,
      hy: e.hy,
      hz: e.hz,
      grows: true,
    };
  },

  crop(c, ctx) {
    if (Number.isFinite(c.radius)) c.radius *= ctx.radiusK;
    if (Number.isFinite(c.hx)) c.hx /= ctx.range.x;
    if (Number.isFinite(c.hy)) c.hy /= ctx.range.y;
    if (Number.isFinite(c.hz)) c.hz /= ctx.range.z;
    if (c.shape === 'cylinder' && Number.isFinite(c.len)) {
      c.len = Math.min(1, c.len / ctx.range[validAxis(c.axis)]);
    }
  },

  glyphs(c, dims) {
    if (c.shape === 'cylinder') {
      const { nx, ny, nz } = dims;
      const maxDim = Math.max(nx, ny, nz);
      const p = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
      const mag = Number.isFinite(c.magnitude) ? c.magnitude : 1;
      const { Rin, wall } = shellRadii(c.radius, c.wall, maxDim);
      const axis = validAxis(c.axis);
      const nA = axis === 'x' ? nx : axis === 'y' ? ny : nz;
      const len = Math.min(1, Math.max(0.05, Number.isFinite(c.len) ? c.len : 0.5));
      const centre = Number.isFinite(c[axis]) ? c[axis] : 0.5;
      const a0 = Math.max(0, Math.round((centre - len / 2) * nA));
      const a1 = Math.min(nA, Math.round((centre + len / 2) * nA));
      return [{
        kind: 'pressure',
        id: c.id,
        ix: p.ix,
        iy: p.iy,
        iz: p.iz,
        shape: 'cylinder',
        axis,
        a0,
        a1,
        radial: c.pressureMode !== 'directional',
        outward: !c.inward !== (mag < 0),
        dir: unitDir(c.fx, c.fy, c.fz, mag),
        radius: Rin,
        cavity: c.cavityVoid !== false,
        wall,
      }];
    }
    const { nx, ny, nz } = dims;
    const maxDim = Math.max(nx, ny, nz);
    const p = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
    const mag = Number.isFinite(c.magnitude) ? c.magnitude : 1;
    const dir = unitDir(c.fx, c.fy, c.fz, mag);
    const shape = c.shape === 'box' ? 'box' : 'sphere';
    const radial = c.pressureMode !== 'directional';
    return [
      {
        kind: 'pressure',
        id: c.id,
        ix: p.ix,
        iy: p.iy,
        iz: p.iz,
        shape,
        radial,
        outward: !c.inward !== (mag < 0),
        dir,
        radius: sphereRadiusCells(c.radius, maxDim),
        cavity: c.cavityVoid !== false,
        wall: Math.max(1, Math.min(6, Math.round(Number(c.wall) || 2))),
        half:
          shape === 'box'
            ? {
                x: Math.max(1, Math.round(Math.abs(c.hx ?? 0.1) * nx)),
                y: Math.max(1, Math.round(Math.abs(c.hy ?? 0.1) * ny)),
                z: Math.max(1, Math.round(Math.abs(c.hz ?? 0.1) * nz)),
              }
            : undefined,
      },
    ];
  },
};
