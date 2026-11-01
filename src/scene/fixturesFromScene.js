import { componentDef, orderedFeatures } from './components/index.js';
import { attachVolume } from './workingVolume.js';

/**
 * Visualization descriptor for a custom scene feature. Compatible with the preset
 * `FixtureDescriptor` (kind + node indices) plus optional glyph metadata.
 *
 * kinds:
 *   supports: 'rest' | 'bolt' | 'wall'
 *   loads:    'load' | 'pressure'
 *
 * @typedef {'rest'|'bolt'|'wall'|'load'|'pressure'} CustomFixtureKind
 * @typedef {Object} CustomFixtureDescriptor
 * @property {CustomFixtureKind} kind
 * @property {number} ix
 * @property {number} iy
 * @property {number} iz
 * @property {string} [id]            scene feature id
 * @property {number} [radius]        glyph radius in node units
 * @property {'x'|'y'|'z'} [axis]     bolt axis
 * @property {number} [a0]            bolt: axial start (node units along `axis`)
 * @property {number} [a1]            bolt: axial end
 * @property {{ x: boolean, y: boolean, z: boolean }} [fixed]  bolt: which translations are clamped
 * @property {{ dir: { x: number, y: number, z: number }, mag: number }[]} [loads]  bolt: bearing vectors
 * @property {{ mode: 'torque'|'radial', sign: 1|-1 }} [circ]  bolt: circular load
 * @property {string} [face]          wall face ('x-' ... 'z+')
 * @property {number} [w]             wall patch extent along first in-plane axis (node units)
 * @property {number} [h]             wall patch extent along second in-plane axis (node units)
 * @property {{ x: number, y: number, z: number }} [dir]  unit force direction (loads)
 * @property {number} [lead]          loads: draw the arrow with its tail at the node (tip `lead` units along dir)
 * @property {'sphere'|'box'} [shape] pressure cavity shape
 * @property {boolean} [outward]      radial pressure points away from cavity centre
 * @property {boolean} [radial]       pressure acts radially (vs along `dir`)
 * @property {{ x: number, y: number, z: number }} [half]  box cavity half-extents (node units)
 * @property {number} [wall]          pressure wall thickness (cells)
 * @property {boolean} [cavity]       pressure carves a void cavity + wall
 */

/**
 * Glyph descriptors for a custom scene.
 *
 * @param {import('./types.js').Scene | null | undefined} scene
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @returns {CustomFixtureDescriptor[]}
 */
export function getCustomFixtureDescriptors(scene, nx, ny, nz) {
  /** @type {CustomFixtureDescriptor[]} */
  const out = [];
  if (!scene) return out;
  const dims = { nx, ny, nz };
  const wb = attachVolume(scene, dims);
  for (const c of orderedFeatures(scene)) {
    if (!c) continue;
    const glyphs = componentDef(c.type)?.glyphs?.(c, dims, wb);
    if (glyphs?.length) out.push(...glyphs);
  }
  return out;
}
