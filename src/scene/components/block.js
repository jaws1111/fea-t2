import { boxHalfCells } from '../geometry.js';
import { normToNodeIndices } from '../tools.js';
import { nextId } from './ids.js';
import { num, stripUndefined } from './shared.js';

function paintBox(c, ctx, target) {
  const { nx, ny, nz } = ctx.dims;
  const p = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
  const b = boxHalfCells(c, ctx.dims);
  for (let ez = Math.max(0, p.iz - b.rz); ez < Math.min(nz, p.iz + b.rz); ez++) {
    for (let ey = Math.max(0, p.iy - b.ry); ey < Math.min(ny, p.iy + b.ry); ey++) {
      for (let ex = Math.max(0, p.ix - b.rx); ex < Math.min(nx, p.ix + b.rx); ex++) {
        target[ctx.E(ex, ey, ez)] = 1;
        ctx.any = true;
      }
    }
  }
}

export const block = {
  type: 'block',
  family: 'fixload',
  label: 'Block',
  icon: 'ph-cube',
  idPrefix: 'block',

  create(partial = {}) {
    const base = {
      id: nextId('block'),
      type: 'block',
      x: 0.5,
      y: 0.5,
      z: 0.5,
      hx: 0.12,
      hy: 0.12,
      hz: 0.12,
      void: false,
    };
    return { ...base, ...stripUndefined(partial), type: 'block' };
  },

  normalize(c) {
    if (!Number.isFinite(c.hx)) c.hx = 0.12;
    if (!Number.isFinite(c.hy)) c.hy = 0.12;
    if (!Number.isFinite(c.hz)) c.hz = 0.12;
    c.hx = Math.min(1, Math.max(0, c.hx));
    c.hy = Math.min(1, Math.max(0, c.hy));
    c.hz = Math.min(1, Math.max(0, c.hz));
    c.void = c.void === true;
  },

  roles() {
    return { support: false, load: false };
  },

  paintSolid(c, ctx) {
    if (c.void === true) return;
    paintBox(c, ctx, ctx.solid);
  },

  paintVoid(c, ctx) {
    if (c.void !== true) return;
    paintBox(c, ctx, ctx.voidm);
  },

  extent(c, dims) {
    const b = boxHalfCells(c, dims);
    return { cx: num(c.x, 0.5), cy: num(c.y, 0.5), cz: num(c.z, 0.5), hx: b.rx, hy: b.ry, hz: b.rz };
  },

  crop(c, ctx) {
    if (Number.isFinite(c.hx)) c.hx = Math.min(1, c.hx / ctx.range.x);
    if (Number.isFinite(c.hy)) c.hy = Math.min(1, c.hy / ctx.range.y);
    if (Number.isFinite(c.hz)) c.hz = Math.min(1, c.hz / ctx.range.z);
  },

  glyphs(c, dims) {
    const p = normToNodeIndices(dims.nx, dims.ny, dims.nz, c.x, c.y, c.z);
    const b = boxHalfCells(c, dims);
    return [{
      kind: 'block',
      id: c.id,
      ix: p.ix,
      iy: p.iy,
      iz: p.iz,
      void: c.void === true,
      half: { x: b.rx, y: b.ry, z: b.rz },
    }];
  },
};
