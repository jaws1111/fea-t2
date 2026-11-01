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

function asPrism(c) {
  return c.profile === 'prism' ? c : { ...c, profile: 'prism' };
}

export const wallPrism = {
  type: 'wall_prism',
  family: 'wall',
  label: 'Prism wall',
  icon: 'ph-hexagon',
  idPrefix: 'wall',

  create(partial = {}) {
    const base = {
      id: nextId('wall'),
      type: 'wall_prism',
      x: 0.5,
      y: 0.5,
      z: 0.5,
      axis: 'z',
      len: 1,
      radius: 0.18,
      wall: 2,
      n: 6,
      rotation: 0,
      active: 'both',
      fixX: true,
      fixY: true,
      fixZ: true,
      solid: true,
    };
    return { ...base, ...stripUndefined(partial), type: 'wall_prism' };
  },

  normalize(c) {
    normalizeRadial(c, { prism: true });
  },

  roles(c) {
    return { support: anyFix(c), load: false };
  },

  fix(c, ctx) {
    if (!anyFix(c)) return;
    fixOpenShell(asPrism(c), ctx);
  },

  paintSolid(c, ctx) {
    paintOpenSolid(asPrism(c), ctx);
  },

  paintVoid(c, ctx) {
    paintOpenVoid(asPrism(c), ctx);
  },

  extent(c, dims) {
    return shellExtent(c, dims, 'prism');
  },

  crop: cropRadial,

  glyphs(c, dims, wb) {
    return [shellGlyph(c, dims, wb, 'prism')];
  },
};
