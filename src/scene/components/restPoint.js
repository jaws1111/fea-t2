import { forNodesInSphere, normToNodeIndices } from '../tools.js';
import { anyFix, applyFixFlags, num, stripUndefined } from './shared.js';
import { nextId } from './ids.js';

const DEFAULT_REST_RADIUS = 0.02;

export const restPoint = {
  type: 'rest_point',
  family: 'rest',
  label: 'Rest',
  icon: 'ph-map-pin',
  idPrefix: 'rest',

  create(partial = {}) {
    const base = {
      id: nextId('rest'),
      type: 'rest_point',
      x: 0.5,
      y: 0,
      z: 0.5,
      radius: 0.03,
      fixX: true,
      fixY: true,
      fixZ: true,
      solid: true,
    };
    return { ...base, ...stripUndefined(partial), type: 'rest_point' };
  },

  normalize() {},

  roles(c) {
    return { support: anyFix(c), load: false };
  },

  fix(c, ctx) {
    if (!anyFix(c)) return;
    const { nx, ny, nz } = ctx.dims;
    const r = c.radius ?? DEFAULT_REST_RADIUS;
    forNodesInSphere(nx, ny, nz, c.x, c.y, c.z, r, (ix, iy, iz) => {
      applyFixFlags(c, ctx, ctx.idx(ix, iy, iz));
    });
  },

  paintSolid(c, ctx) {
    if (c.solid === false) return;
    const { nx, ny, nz } = ctx.dims;
    const cpt = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
    const R = Math.max(1.5, (c.radius ?? 0.03) * ctx.maxDim * 1.5);
    const R2 = R * R;
    const r = Math.ceil(R);
    for (let ez = Math.max(0, cpt.iz - r); ez < Math.min(nz, cpt.iz + r); ez++) {
      for (let ey = Math.max(0, cpt.iy - r); ey < Math.min(ny, cpt.iy + r); ey++) {
        for (let ex = Math.max(0, cpt.ix - r); ex < Math.min(nx, cpt.ix + r); ex++) {
          const dx = ex + 0.5 - cpt.ix;
          const dy = ey + 0.5 - cpt.iy;
          const dz = ez + 0.5 - cpt.iz;
          if (dx * dx + dy * dy + dz * dz > R2) continue;
          ctx.solid[ctx.E(ex, ey, ez)] = 1;
          ctx.any = true;
        }
      }
    }
  },

  extent(c, dims) {
    const maxDim = Math.max(dims.nx, dims.ny, dims.nz);
    const r = Math.max(1.5, num(c.radius, 0.03) * maxDim * 1.5) + 1;
    return { cx: num(c.x, 0.5), cy: num(c.y, 0.5), cz: num(c.z, 0.5), hx: r, hy: r, hz: r };
  },

  crop(c, ctx) {
    if (Number.isFinite(c.radius)) c.radius *= ctx.radiusK;
  },

  glyphs(c, dims) {
    const { nx, ny, nz } = dims;
    const maxDim = Math.max(nx, ny, nz);
    const p = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
    return [
      {
        kind: 'rest',
        id: c.id,
        ix: p.ix,
        iy: p.iy,
        iz: p.iz,
        radius: Math.max(0.5, (c.radius ?? 0.02) * maxDim),
      },
    ];
  },
};
