import { perpAxes, validAxis } from '../geometry.js';
import { forNodesOnPlanePatch, normToNodeIndices } from '../tools.js';
import { nextId } from './ids.js';
import { anyFix, applyFixFlags, num, stripUndefined } from './shared.js';

export const restPad = {
  type: 'rest_pad',
  family: 'rest',
  label: 'Rest pad',
  icon: 'ph-square-half',
  idPrefix: 'rest',

  create(partial = {}) {
    const base = {
      id: nextId('rest'),
      type: 'rest_pad',
      x: 0.5,
      y: 0.5,
      z: 0.5,
      axis: 'y',
      width: 0.25,
      height: 0.25,
      depth: 1,
      fixX: true,
      fixY: true,
      fixZ: true,
      solid: true,
    };
    return { ...base, ...stripUndefined(partial), type: 'rest_pad' };
  },

  normalize(c) {
    c.axis = validAxis(c.axis);
    if (!Number.isFinite(c.width)) c.width = 0.25;
    if (!Number.isFinite(c.height)) c.height = 0.25;
    c.width = Math.min(1, Math.max(0, c.width));
    c.height = Math.min(1, Math.max(0, c.height));
    c.depth = Math.max(1, Math.min(6, Math.round(Number.isFinite(c.depth) ? c.depth : 1)));
    if (c.solid == null) c.solid = true;
  },

  roles(c) {
    return { support: anyFix(c), load: false };
  },

  fix(c, ctx) {
    if (!anyFix(c)) return;
    const { nx, ny, nz } = ctx.dims;
    forNodesOnPlanePatch(
      nx, ny, nz, c.axis, c.x, c.y, c.z, c.width ?? 0.25, c.height ?? 0.25, c.depth ?? 1,
      (ix, iy, iz) => applyFixFlags(c, ctx, ctx.idx(ix, iy, iz)),
    );
  },

  paintSolid(c, ctx) {
    if (c.solid === false) return;
    const { nx, ny, nz } = ctx.dims;
    forNodesOnPlanePatch(
      nx, ny, nz, c.axis, c.x, c.y, c.z, c.width ?? 0.25, c.height ?? 0.25, c.depth ?? 1,
      (ix, iy, iz) => {
        for (let ez = iz - 1; ez <= iz; ez++) {
          if (ez < 0 || ez >= nz) continue;
          for (let ey = iy - 1; ey <= iy; ey++) {
            if (ey < 0 || ey >= ny) continue;
            for (let ex = ix - 1; ex <= ix; ex++) {
              if (ex < 0 || ex >= nx) continue;
              ctx.solid[ctx.E(ex, ey, ez)] = 1;
              ctx.any = true;
            }
          }
        }
      },
    );
  },

  extent(c, dims) {
    const axis = validAxis(c.axis);
    const [pa, pb] = perpAxes(axis);
    const n = { x: dims.nx, y: dims.ny, z: dims.nz };
    const half = { x: 1, y: 1, z: 1 };
    half[pa] = (Math.max(0.05, num(c.width, 0.25)) / 2) * n[pa];
    half[pb] = (Math.max(0.05, num(c.height, 0.25)) / 2) * n[pb];
    half[axis] = Math.max(1, Math.round(num(c.depth, 1))) ;
    return { cx: num(c.x, 0.5), cy: num(c.y, 0.5), cz: num(c.z, 0.5), hx: half.x, hy: half.y, hz: half.z };
  },

  crop(c, ctx) {
    const axis = validAxis(c.axis);
    const [pa, pb] = perpAxes(axis);
    if (Number.isFinite(c.width)) c.width = Math.min(1, c.width / ctx.range[pa]);
    if (Number.isFinite(c.height)) c.height = Math.min(1, c.height / ctx.range[pb]);
  },

  glyphs(c, dims) {
    const axis = validAxis(c.axis);
    const [pa, pb] = perpAxes(axis);
    const n = { x: dims.nx, y: dims.ny, z: dims.nz };
    const p = normToNodeIndices(dims.nx, dims.ny, dims.nz, c.x, c.y, c.z);
    return [{
      kind: 'pad',
      id: c.id,
      ix: p.ix,
      iy: p.iy,
      iz: p.iz,
      axis,
      w: Math.min(1, Math.max(0, c.width ?? 0.25)) * n[pa],
      h: Math.min(1, Math.max(0, c.height ?? 0.25)) * n[pb],
    }];
  },
};
