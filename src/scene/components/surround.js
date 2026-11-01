import { nextId } from './ids.js';
import {
  cropRadial,
  fixSphereShell,
  fixTubeShell,
  normalizeRadial,
  paintSphereSolid,
  paintSphereVoid,
  paintTubeSolid,
  paintTubeVoid,
  shellExtent,
  shellGlyph,
} from './shells.js';
import { anyFix, stripUndefined } from './shared.js';

function asClosed(c) {
  return c.shape === 'ngon' ? { ...c, profile: 'prism' } : c;
}

export const surround = {
  type: 'surround',
  family: 'wall',
  label: 'Surround',
  icon: 'ph-sphere',
  idPrefix: 'wall',

  create(partial = {}) {
    const base = {
      id: nextId('wall'),
      type: 'surround',
      x: 0.5,
      y: 0.5,
      z: 0.5,
      shape: 'sphere',
      axis: 'z',
      len: 0.7,
      radius: 0.2,
      wall: 2,
      n: 6,
      rotation: 0,
      active: 'inner',
      fixX: true,
      fixY: true,
      fixZ: true,
      solid: true,
    };
    return { ...base, ...stripUndefined(partial), type: 'surround' };
  },

  normalize(c) {
    c.shape = c.shape === 'ngon' ? 'ngon' : 'sphere';
    normalizeRadial(c, { prism: c.shape === 'ngon' });
  },

  roles(c) {
    return { support: anyFix(c), load: false };
  },

  fix(c, ctx) {
    if (!anyFix(c)) return;
    if (c.shape === 'ngon') fixTubeShell(asClosed(c), ctx);
    else fixSphereShell(c, ctx);
  },

  paintSolid(c, ctx) {
    if (c.shape === 'ngon') paintTubeSolid(asClosed(c), ctx);
    else paintSphereSolid(c, ctx);
  },

  paintVoid(c, ctx) {
    if (c.shape === 'ngon') paintTubeVoid(asClosed(c), ctx);
    else paintSphereVoid(c, ctx);
  },

  extent(c, dims) {
    return shellExtent(c, dims, c.shape === 'ngon' ? 'prism' : 'sphere');
  },

  crop: cropRadial,

  glyphs(c, dims, wb) {
    return [shellGlyph(c, dims, wb, c.shape === 'ngon' ? 'prism' : 'sphere')];
  },
};
