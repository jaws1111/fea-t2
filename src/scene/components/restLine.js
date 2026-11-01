import { forNodesOnLine } from '../tools.js';
import { nextId } from './ids.js';
import { anyFix, applyFixFlags, num, stripUndefined } from './shared.js';

function axisOf(c) {
  return c.axis === 'x' || c.axis === 'y' || c.axis === 'z' ? c.axis : 'z';
}

export const restLine = {
  type: 'rest_line',
  family: 'rest',
  label: 'Rest line',
  icon: 'ph-line-segment',
  idPrefix: 'rest',

  create(partial = {}) {
    const base = {
      id: nextId('rest'),
      type: 'rest_line',
      x: 0,
      y: 0,
      z: 0.5,
      axis: 'z',
      len: 1,
      fixX: true,
      fixY: true,
      fixZ: true,
      solid: true,
    };
    return { ...base, ...stripUndefined(partial), type: 'rest_line' };
  },

  normalize(c) {
    c.axis = axisOf(c);
    c.len = Math.min(1, Math.max(0, num(c.len, 1)));
    if (c.solid == null) c.solid = true;
  },

  roles(c) {
    return { support: anyFix(c), load: false };
  },

  fix(c, ctx) {
    if (!anyFix(c)) return;
    const { nx, ny, nz } = ctx.dims;
    forNodesOnLine(nx, ny, nz, c.axis, c.x, c.y, c.z, c.len ?? 1, (ix, iy, iz) => {
      applyFixFlags(c, ctx, ctx.idx(ix, iy, iz));
    });
  },

  paintSolid(c, ctx) {
    if (c.solid === false) return;
    const { nx, ny, nz } = ctx.dims;
    forNodesOnLine(nx, ny, nz, c.axis, c.x, c.y, c.z, c.len ?? 1, (ix, iy, iz) => {
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
    });
  },

  extent(c, dims) {
    const axis = axisOf(c);
    const n = dims[axis === 'x' ? 'nx' : axis === 'y' ? 'ny' : 'nz'];
    const centre = num(c[axis], 0.5);
    const len = Math.min(1, Math.max(0, num(c.len, 1)));
    const s0 = Math.max(0, centre - len / 2);
    const s1 = Math.min(1, centre + len / 2);
    const half = { x: 1, y: 1, z: 1 };
    half[axis] = Math.max(1, ((s1 - s0) * n) / 2);
    const cen = { x: num(c.x, 0.5), y: num(c.y, 0.5), z: num(c.z, 0.5) };
    cen[axis] = (s0 + s1) / 2;
    return { cx: cen.x, cy: cen.y, cz: cen.z, hx: half.x, hy: half.y, hz: half.z };
  },

  crop(c, ctx) {
    const axis = axisOf(c);
    if (Number.isFinite(c.len)) c.len = Math.min(1, Math.max(0, c.len / ctx.range[axis]));
  },

  glyphs(c, dims) {
    const { nx, ny, nz } = dims;
    /** @type {{ ix: number, iy: number, iz: number }[]} */
    const pts = [];
    forNodesOnLine(nx, ny, nz, c.axis, c.x, c.y, c.z, c.len ?? 1, (ix, iy, iz) => {
      pts.push({ ix, iy, iz });
    });
    const onEdge = pts.length > 0 && pts.every((p) => p.iy === 0 || p.iy === ny);
    const kind = onEdge ? 'pier' : 'axle';
    const stride = Math.max(1, Math.ceil(pts.length / 40));
    return pts.filter((_, i) => i % stride === 0).map((p) => ({ kind, id: c.id, ...p }));
  },
};
