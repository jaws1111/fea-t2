import { holeFrame, validAxis } from '../geometry.js';
import { forNodesOnCylinderShell, normRadiusToNodes, normToNode, normToNodeIndices } from '../tools.js';
import { nextId } from './ids.js';
import { anyFix, applyFixFlags, num, stripUndefined } from './shared.js';

function ringRadius(c, maxDim) {
  return Math.max(1, normRadiusToNodes(maxDim, maxDim, maxDim, c.radius ?? 0.12));
}

function ringThickness(c, maxDim) {
  const band = Number.isFinite(c.band) ? c.band : 0;
  return band > 0 ? Math.max(0.75, band * maxDim) : 0.75;
}

export const restRing = {
  type: 'rest_ring',
  family: 'rest',
  label: 'Rest ring',
  icon: 'ph-circle',
  idPrefix: 'rest',

  create(partial = {}) {
    const base = {
      id: nextId('rest'),
      type: 'rest_ring',
      x: 0.5,
      y: 0.5,
      z: 0.5,
      axis: 'z',
      radius: 0.12,
      band: 0,
      fixX: true,
      fixY: true,
      fixZ: true,
      solid: true,
    };
    return { ...base, ...stripUndefined(partial), type: 'rest_ring' };
  },

  normalize(c) {
    c.axis = validAxis(c.axis);
    if (!Number.isFinite(c.radius)) c.radius = 0.12;
    c.radius = Math.max(0, c.radius);
    if (!Number.isFinite(c.band) || c.band < 0) c.band = 0;
    if (c.solid == null) c.solid = true;
  },

  roles(c) {
    return { support: anyFix(c), load: false };
  },

  fix(c, ctx) {
    if (!anyFix(c)) return;
    const { nx, ny, nz } = ctx.dims;
    const frame = holeFrame(c, ctx.dims);
    const [pa, pb] = frame.perp;
    forNodesOnCylinderShell(
      nx, ny, nz, frame.axis, c[pa], c[pb], c[frame.axis], c.radius ?? 0.12,
      (ix, iy, iz) => applyFixFlags(c, ctx, ctx.idx(ix, iy, iz)),
      ringThickness(c, ctx.maxDim),
    );
  },

  paintSolid(c, ctx) {
    if (c.solid === false) return;
    const { nx, ny, nz } = ctx.dims;
    const frame = holeFrame(c, ctx.dims);
    const R = ringRadius(c, ctx.maxDim);
    const thick = ringThickness(c, ctx.maxDim) + 0.75;
    const a = normToNode(c[frame.axis], frame.nA);
    const r = Math.ceil(R + thick) + 1;
    for (let e2 = Math.max(0, frame.i2 - r); e2 < Math.min(frame.n2, frame.i2 + r); e2++) {
      for (let e1 = Math.max(0, frame.i1 - r); e1 < Math.min(frame.n1, frame.i1 + r); e1++) {
        const d = Math.hypot(e1 + 0.5 - frame.i1, e2 + 0.5 - frame.i2);
        if (Math.abs(d - R) > thick) continue;
        for (let ea = a - 1; ea <= a; ea++) {
          if (ea < 0 || ea >= frame.nA) continue;
          const xyz = [0, 0, 0];
          if (frame.axis === 'x') {
            xyz[0] = ea; xyz[1] = e1; xyz[2] = e2;
          } else if (frame.axis === 'y') {
            xyz[0] = e1; xyz[1] = ea; xyz[2] = e2;
          } else {
            xyz[0] = e1; xyz[1] = e2; xyz[2] = ea;
          }
          if (xyz[0] < 0 || xyz[1] < 0 || xyz[2] < 0 || xyz[0] >= nx || xyz[1] >= ny || xyz[2] >= nz) continue;
          ctx.solid[ctx.E(xyz[0], xyz[1], xyz[2])] = 1;
          ctx.any = true;
        }
      }
    }
  },

  extent(c, dims) {
    const maxDim = Math.max(dims.nx, dims.ny, dims.nz);
    const R = ringRadius(c, maxDim) + ringThickness(c, maxDim) + 1;
    const axis = validAxis(c.axis);
    const half = { x: R, y: R, z: R };
    half[axis] = 1.5;
    return { cx: num(c.x, 0.5), cy: num(c.y, 0.5), cz: num(c.z, 0.5), hx: half.x, hy: half.y, hz: half.z };
  },

  crop(c, ctx) {
    if (Number.isFinite(c.radius)) c.radius *= ctx.radiusK;
    if (Number.isFinite(c.band) && c.band > 0) c.band *= ctx.radiusK;
  },

  glyphs(c, dims) {
    const { nx, ny, nz } = dims;
    const maxDim = Math.max(nx, ny, nz);
    const p = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
    const axis = validAxis(c.axis);
    if (axis === 'x') p.ix = normToNode(c.x, nx);
    else if (axis === 'y') p.iy = normToNode(c.y, ny);
    else p.iz = normToNode(c.z, nz);
    return [{
      kind: 'ring',
      id: c.id,
      ix: p.ix,
      iy: p.iy,
      iz: p.iz,
      axis,
      radius: ringRadius(c, maxDim),
    }];
  },
};
