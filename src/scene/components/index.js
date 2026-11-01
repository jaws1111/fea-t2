import { block } from './block.js';
import { boltHole } from './boltHole.js';
import { faceLoad } from './faceLoad.js';
import { lineLoad } from './lineLoad.js';
import { pointLoad } from './pointLoad.js';
import { pressure } from './pressure.js';
import { restLine } from './restLine.js';
import { restPad } from './restPad.js';
import { restPoint } from './restPoint.js';
import { restRing } from './restRing.js';
import { surround } from './surround.js';
import { wallCylinder } from './wallCylinder.js';
import { wallPad } from './wallPad.js';
import { wallPrism } from './wallPrism.js';

/** @type {Readonly<Record<string, import('./restPoint.js').restPoint>>} */
export const COMPONENTS = Object.freeze({
  rest_point: restPoint,
  rest_line: restLine,
  rest_ring: restRing,
  rest_pad: restPad,
  bolt_hole: boltHole,
  wall_pad: wallPad,
  wall_cylinder: wallCylinder,
  wall_prism: wallPrism,
  surround,
  block,
  point_load: pointLoad,
  line_load: lineLoad,
  face_load: faceLoad,
  pressure,
});

/** @type {readonly string[]} */
export const COMPONENT_TYPES = Object.freeze(Object.keys(COMPONENTS));

export const FAMILIES = Object.freeze([
  { id: 'wall', label: 'Wall' },
  { id: 'rest', label: 'Rest' },
  { id: 'fixload', label: 'Fixed and loaded' },
]);

/** @param {string} type */
export function componentDef(type) {
  return COMPONENTS[type] ?? null;
}

/** @param {{ components?: any[] } | null | undefined} scene */
export function orderedFeatures(scene) {
  return scene?.components ?? [];
}
