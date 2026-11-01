import { boltHole } from './boltHole.js';
import { pointLoad } from './pointLoad.js';
import { pressure } from './pressure.js';
import { restPoint } from './restPoint.js';
import { wallPad } from './wallPad.js';

/** @type {Readonly<Record<string, import('./restPoint.js').restPoint>>} */
export const COMPONENTS = Object.freeze({
  rest_point: restPoint,
  bolt_hole: boltHole,
  wall_pad: wallPad,
  point_load: pointLoad,
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

/**
 * Fixations first, then forces. Scene v3 stores that same order in `components`.
 * @param {{ fixations?: any[], forces?: any[], components?: any[] } | null | undefined} scene
 */
export function orderedFeatures(scene) {
  if (Array.isArray(scene?.components)) return scene.components;
  return [...(scene?.fixations ?? []), ...(scene?.forces ?? [])];
}
