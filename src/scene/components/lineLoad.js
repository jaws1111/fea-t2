import { forNodesOnLine } from '../tools.js';
import { nextId } from './ids.js';
import { distributeResultant, normalizeDir, num, stripUndefined, unitDir } from './shared.js';

function axisOf(c) {
  return c.axis === 'x' || c.axis === 'y' || c.axis === 'z' ? c.axis : 'z';
}

export const lineLoad = {
  type: 'line_load',
  family: 'fixload',
  label: 'Line load',
  icon: 'ph-arrow-line-down',
  idPrefix: 'load',

  create(partial = {}) {
    const base = {
      id: nextId('load'),
      type: 'line_load',
      x: 0.5,
      y: 1,
      z: 0.5,
      axis: 'z',
      len: 1,
      fx: 0,
      fy: -1,
      fz: 0,
      magnitude: 1,
    };
    return { ...base, ...stripUndefined(partial), type: 'line_load' };
  },

  normalize(c) {
    c.axis = axisOf(c);
    c.len = Math.min(1, Math.max(0, num(c.len, 1)));
    c.magnitude = num(c.magnitude, 1);
  },

  roles() {
    return { support: false, load: true };
  },

  load(c, ctx) {
    const { nx, ny, nz } = ctx.dims;
    /** @type {{ n: number, w: number }[]} */
    const nodes = [];
    forNodesOnLine(nx, ny, nz, c.axis, c.x, c.y, c.z, c.len ?? 1, (ix, iy, iz) => {
      nodes.push({ n: ctx.idx(ix, iy, iz), w: 1 });
    });
    distributeResultant(ctx.F, nodes, normalizeDir(c.fx, c.fy, c.fz), num(c.magnitude, 1));
    ctx.count.loadedNodes += nodes.length;
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
    const body = pts.length > 2 ? pts.slice(1, -1) : pts;
    const stride = Math.max(1, Math.ceil(body.length / 12));
    const dir = unitDir(c.fx, c.fy, c.fz, num(c.magnitude, 1));
    return body.filter((_, i) => i % stride === 0).map((p) => ({ kind: 'load', id: c.id, ...p, dir }));
  },
};
