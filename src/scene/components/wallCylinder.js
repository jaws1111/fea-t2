import { nextId } from './ids.js';
import {
  cropRadial,
  fixOpenShell,
  normalizeRadial,
  paintOpenSolid,
  paintOpenVoid,
  shellExtent,
  shellGlyph,
} from './shells.js';
import { anyFix, stripUndefined } from './shared.js';

function asCylinder(c) {
  return c.profile === 'cylinder' ? c : { ...c, profile: 'cylinder' };
}

export const wallCylinder = {
  type: 'wall_cylinder',
  family: 'wall',
  label: 'Cylinder wall',
  icon: 'ph-cylinder',
  idPrefix: 'wall',

  create(partial = {}) {
    const base = {
      id: nextId('wall'),
      type: 'wall_cylinder',
      x: 0.5,
      y: 0.5,
      z: 0.5,
      axis: 'z',
      len: 1,
      radius: 0.15,
      wall: 2,
      active: 'both',
      fixX: true,
      fixY: true,
      fixZ: true,
      solid: true,
    };
    return { ...base, ...stripUndefined(partial), type: 'wall_cylinder' };
  },

  normalize(c) {
    normalizeRadial(c);
  },

  roles(c) {
    return { support: anyFix(c), load: false };
  },

  fix(c, ctx) {
    if (!anyFix(c)) return;
    fixOpenShell(asCylinder(c), ctx);
  },

  paintSolid(c, ctx) {
    paintOpenSolid(asCylinder(c), ctx);
  },

  paintVoid(c, ctx) {
    paintOpenVoid(asCylinder(c), ctx);
  },

  extent(c, dims) {
    return shellExtent(c, dims, 'cylinder');
  },

  crop: cropRadial,

  glyphs(c, dims, wb) {
    return [shellGlyph(c, dims, wb, 'cylinder')];
  },
};
