import { forNodesOnFacePatch, normToNodeIndices } from '../tools.js';
import { toXYZ } from '../geometry.js';
import { nextId } from './ids.js';
import { anyFix, applyFixFlags, faceFrame, num, stripUndefined } from './shared.js';

export const wallPad = {
  type: 'wall_pad',
  family: 'wall',
  label: 'Wall pad',
  icon: 'ph-square',
  idPrefix: 'wall',

  create(partial = {}) {
    const base = {
      id: nextId('wall'),
      type: 'wall_pad',
      x: 0.5,
      y: 0,
      z: 0.5,
      face: 'x-',
      width: 1,
      height: 1,
      depth: 1,
      fixX: true,
      fixY: true,
      fixZ: true,
    };
    return { ...base, ...stripUndefined(partial), type: 'wall_pad' };
  },

  normalize() {},

  roles(c) {
    return { support: anyFix(c), load: false };
  },

  fix(c, ctx) {
    if (!anyFix(c)) return;
    const { nx, ny, nz } = ctx.dims;
    const frame = faceFrame(c.face, ctx.dims);
    const [u, v] = [c[frame.perp[0]], c[frame.perp[1]]];
    forNodesOnFacePatch(nx, ny, nz, frame.face, u, v, c.width ?? 1, c.height ?? 1, c.depth ?? 1, (ix, iy, iz) => {
      applyFixFlags(c, ctx, ctx.idx(ix, iy, iz));
    });
  },

  paintSolid(c, ctx) {
    const frame = faceFrame(c.face, ctx.dims);
    const { axis, high, perp, n } = frame;
    const layers = Math.max(2, Math.round(c.depth ?? 2));
    const width = c.width ?? 1;
    const height = c.height ?? 1;
    const nU = n[perp[0]];
    const nV = n[perp[1]];
    const nA = n[axis];
    const u = c[perp[0]];
    const v = c[perp[1]];
    const u0 = Math.max(0, Math.round((u - Math.max(0, width) / 2) * nU));
    const u1 = Math.min(nU - 1, Math.round((u + Math.max(0, width) / 2) * nU) - 1);
    const v0 = Math.max(0, Math.round((v - Math.max(0, height) / 2) * nV));
    const v1 = Math.min(nV - 1, Math.round((v + Math.max(0, height) / 2) * nV) - 1);
    const xyz = [0, 0, 0];
    for (let l = 0; l < layers; l++) {
      const a = high ? nA - 1 - l : l;
      if (a < 0 || a >= nA) continue;
      for (let pv = v0; pv <= v1; pv++) {
        for (let pu = u0; pu <= u1; pu++) {
          toXYZ(axis, pu, pv, a, xyz);
          ctx.solid[ctx.E(xyz[0], xyz[1], xyz[2])] = 1;
          ctx.any = true;
        }
      }
    }
  },

  extent(c, dims) {
    const frame = faceFrame(c.face, dims);
    const { axis, high, perp, n } = frame;
    const halfU = (Math.max(0.05, num(c.width, 1)) / 2) * n[perp[0]];
    const halfV = (Math.max(0.05, num(c.height, 1)) / 2) * n[perp[1]];
    const layers = Math.max(2, Math.round(num(c.depth, 1))) + 1;
    const half = { x: 0, y: 0, z: 0 };
    half[perp[0]] = halfU;
    half[perp[1]] = halfV;
    const faceN = high ? 1 : 0;
    const into = high ? -layers / 2 : layers / 2;
    const cen = { x: num(c.x, 0.5), y: num(c.y, 0.5), z: num(c.z, 0.5) };
    cen[axis] = faceN + into / n[axis];
    half[axis] = layers / 2;
    return { cx: cen.x, cy: cen.y, cz: cen.z, hx: half.x, hy: half.y, hz: half.z };
  },

  crop(c, ctx) {
    if (Number.isFinite(c.radius)) c.radius *= ctx.radiusK;
    const axis = (c.face ?? 'x-')[0];
    const [pa, pb] = axis === 'x' ? ['y', 'z'] : axis === 'y' ? ['x', 'z'] : ['x', 'y'];
    if (Number.isFinite(c.width)) c.width = Math.min(1, c.width / ctx.range[pa]);
    if (Number.isFinite(c.height)) c.height = Math.min(1, c.height / ctx.range[pb]);
  },

  glyphs(c, dims) {
    const { nx, ny, nz } = dims;
    const frame = faceFrame(c.face, dims);
    const p = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
    const pos = { ix: p.ix, iy: p.iy, iz: p.iz };
    if (frame.axis === 'x') pos.ix = frame.high ? nx : 0;
    else if (frame.axis === 'y') pos.iy = frame.high ? ny : 0;
    else pos.iz = frame.high ? nz : 0;
    const d = frame.axis === 'x' ? [ny, nz] : frame.axis === 'y' ? [nx, nz] : [nx, ny];
    return [
      {
        kind: 'wall',
        id: c.id,
        ix: pos.ix,
        iy: pos.iy,
        iz: pos.iz,
        face: frame.face,
        w: Math.min(1, Math.max(0, c.width ?? 1)) * d[0],
        h: Math.min(1, Math.max(0, c.height ?? 1)) * d[1],
      },
    ];
  },
};
