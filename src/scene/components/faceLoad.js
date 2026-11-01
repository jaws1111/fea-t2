import { forNodesOnFacePatch } from '../tools.js';
import { nextId } from './ids.js';
import { distributeResultant, faceFrame, normalizeDir, num, stripUndefined, unitDir } from './shared.js';

export const faceLoad = {
  type: 'face_load',
  family: 'fixload',
  label: 'Face load',
  icon: 'ph-square-half',
  idPrefix: 'load',

  create(partial = {}) {
    const base = {
      id: nextId('load'),
      type: 'face_load',
      x: 0.5,
      y: 1,
      z: 0.5,
      face: 'y+',
      width: 1,
      height: 1,
      fx: 0,
      fy: -1,
      fz: 0,
      magnitude: 1,
    };
    return { ...base, ...stripUndefined(partial), type: 'face_load' };
  },

  normalize(c) {
    c.magnitude = num(c.magnitude, 1);
    c.width = num(c.width, 1);
    c.height = num(c.height, 1);
  },

  roles() {
    return { support: false, load: true };
  },

  load(c, ctx) {
    const { nx, ny, nz } = ctx.dims;
    const frame = faceFrame(c.face, ctx.dims);
    const u = c[frame.perp[0]];
    const v = c[frame.perp[1]];
    /** @type {{ n: number, w: number, ix: number, iy: number, iz: number }[]} */
    const nodes = [];
    forNodesOnFacePatch(nx, ny, nz, frame.face, u, v, c.width ?? 1, c.height ?? 1, 1, (ix, iy, iz) => {
      nodes.push({ n: ctx.idx(ix, iy, iz), w: 1, ix, iy, iz });
    });
    distributeResultant(ctx.F, nodes, normalizeDir(c.fx, c.fy, c.fz), num(c.magnitude, 1));
    ctx.count.loadedNodes += nodes.length;
  },

  extent(c, dims) {
    const frame = faceFrame(c.face, dims);
    const { axis, high, perp, n } = frame;
    const half = { x: 1, y: 1, z: 1 };
    half[perp[0]] = (Math.max(0.05, num(c.width, 1)) / 2) * n[perp[0]];
    half[perp[1]] = (Math.max(0.05, num(c.height, 1)) / 2) * n[perp[1]];
    half[axis] = 1;
    const cen = { x: num(c.x, 0.5), y: num(c.y, 0.5), z: num(c.z, 0.5) };
    cen[axis] = high ? 1 : 0;
    return { cx: cen.x, cy: cen.y, cz: cen.z, hx: half.x, hy: half.y, hz: half.z };
  },

  crop(c, ctx) {
    const axis = (c.face ?? 'y+')[0];
    const [pa, pb] = axis === 'x' ? ['y', 'z'] : axis === 'y' ? ['x', 'z'] : ['x', 'y'];
    if (Number.isFinite(c.width)) c.width = Math.min(1, c.width / ctx.range[pa]);
    if (Number.isFinite(c.height)) c.height = Math.min(1, c.height / ctx.range[pb]);
  },

  glyphs(c, dims) {
    const { nx, ny, nz } = dims;
    const frame = faceFrame(c.face, dims);
    const u = c[frame.perp[0]];
    const v = c[frame.perp[1]];
    /** @type {{ ix: number, iy: number, iz: number }[]} */
    const pts = [];
    forNodesOnFacePatch(nx, ny, nz, frame.face, u, v, c.width ?? 1, c.height ?? 1, 1, (ix, iy, iz) => {
      pts.push({ ix, iy, iz });
    });
    if (!pts.length) return [];
    const dir = unitDir(c.fx, c.fy, c.fz, num(c.magnitude, 1));
    /** @type {object[]} */
    const out = [];
    if (frame.face === 'y+' || frame.face === 'y-') {
      let ix0 = pts[0].ix;
      let ix1 = pts[0].ix;
      let iz0 = pts[0].iz;
      let iz1 = pts[0].iz;
      for (const p of pts) {
        ix0 = Math.min(ix0, p.ix);
        ix1 = Math.max(ix1, p.ix);
        iz0 = Math.min(iz0, p.iz);
        iz1 = Math.max(iz1, p.iz);
      }
      out.push({ kind: 'road', id: c.id, ix: ix0, iy: pts[0].iy, iz: iz0, ix1, iz1 });
    }
    const stride = Math.max(1, Math.ceil(pts.length / 24));
    for (let i = 0; i < pts.length; i += stride) {
      out.push({ kind: 'load', id: c.id, ...pts[i], dir, scale: nx >= 40 ? 0.55 : 0.7 });
    }
    return out;
  },
};
