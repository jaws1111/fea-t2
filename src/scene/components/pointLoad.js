import { normToNodeIndices } from '../tools.js';
import { POINT_DIRS, pointLoadAxes, pointLoadCaseCount, pointLoadComponents, pointLoadDirs, pointLoadMode, pointSpreadCells } from '../pointLoad.js';
import { nextId } from './ids.js';
import { num, stripUndefined, unitDir } from './shared.js';

export const pointLoad = {
  type: 'point_load',
  family: 'fixload',
  label: 'Point load',
  icon: 'ph-arrow-down',
  idPrefix: 'load',

  create(partial = {}) {
    const base = {
      id: nextId('load'),
      type: 'point_load',
      x: 0.5,
      y: 1,
      z: 0.5,
      fx: 0,
      fy: -1,
      fz: 0,
      magnitude: 1,
      radius: 0.04,
      axes: 1,
      dirs: [],
      axesMode: 'cases',
    };
    const out = { ...base, ...stripUndefined(partial), type: 'point_load' };
    if (out.axes > 1 && !(out.dirs?.length >= out.axes)) out.dirs = pointLoadDirs(out);
    return out;
  },

  normalize(c) {
    c.axes = pointLoadAxes(c);
    c.axesMode = pointLoadMode(c);
    c.dirs = c.axes > 1 ? pointLoadDirs(c) : Array.isArray(c.dirs) ? c.dirs.filter((d) => POINT_DIRS.includes(d)) : [];
  },

  roles() {
    return { support: false, load: true };
  },

  loadCases(c) {
    return pointLoadCaseCount(c);
  },

  load(c, ctx) {
    const { nx, ny, nz } = ctx.dims;
    const p = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
    for (const comp of pointLoadComponents(c, ctx.maxDim, ctx.loadCase)) {
      const ix = Math.max(0, Math.min(nx, p.ix + comp.off[0]));
      const iy = Math.max(0, Math.min(ny, p.iy + comp.off[1]));
      const iz = Math.max(0, Math.min(nz, p.iz + comp.off[2]));
      const n = ctx.idx(ix, iy, iz);
      ctx.F[3 * n] += comp.dir[0] * comp.mag;
      ctx.F[3 * n + 1] += comp.dir[1] * comp.mag;
      ctx.F[3 * n + 2] += comp.dir[2] * comp.mag;
      ctx.count.loadedNodes++;
    }
  },

  extent(c, dims) {
    const maxDim = Math.max(dims.nx, dims.ny, dims.nz);
    const burst = pointLoadAxes(c) > 1 && pointLoadMode(c) === 'burst';
    const reach = burst ? pointSpreadCells(c, maxDim) + 1.5 : 2.5;
    return { cx: num(c.x, 0.5), cy: num(c.y, 0.5), cz: num(c.z, 0.5), hx: reach, hy: reach, hz: reach };
  },

  crop(c, ctx) {
    if (Number.isFinite(c.radius)) c.radius *= ctx.radiusK;
  },

  glyphs(c, dims) {
    const { nx, ny, nz } = dims;
    const maxDim = Math.max(nx, ny, nz);
    const p = normToNodeIndices(nx, ny, nz, c.x, c.y, c.z);
    const mag = Number.isFinite(c.magnitude) ? c.magnitude : 1;
    const dir = unitDir(c.fx, c.fy, c.fz, mag);
    const comps = pointLoadComponents(c, maxDim);
    if (!comps.length) {
      return [{ kind: 'load', id: c.id, ix: p.ix, iy: p.iy, iz: p.iz, dir }];
    }
    return comps.map((comp) => ({
      kind: 'load',
      id: c.id,
      ix: Math.max(0, Math.min(nx, p.ix + comp.off[0])),
      iy: Math.max(0, Math.min(ny, p.iy + comp.off[1])),
      iz: Math.max(0, Math.min(nz, p.iz + comp.off[2])),
      dir: { x: comp.dir[0], y: comp.dir[1], z: comp.dir[2] },
      lead: comps.length > 1 && pointLoadMode(c) === 'cases' ? 2.2 : undefined,
    }));
  },
};
