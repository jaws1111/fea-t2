import { applyCustomBCs } from '../scene/applyCustomBCs.js';
import { getCustomFixtureDescriptors } from '../scene/fixturesFromScene.js';

/**
 * Apply boundary conditions. Classic problems are scene recipes, so the only
 * remaining path is the scene. `preset` stays in the signature until the worker
 * protocol drops it.
 * @param {Uint8Array} fixedDofs
 * @param {Float32Array} F
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @param {string} _preset
 * @param {import('../scene/types.js').Scene | null} [scene]
 */
export function applyBCs(fixedDofs, F, nx, ny, nz, _preset, scene = null, loadCase = 0) {
  if (scene) applyCustomBCs(fixedDofs, F, nx, ny, nz, scene, loadCase);
}

/**
 * @typedef {'pier'|'wall'|'sym'|'axle'|'load'|'rest'|'bolt'|'bolt_force'|'pressure'|'road'} FixtureKind
 * @typedef {{ kind: FixtureKind, ix: number, iy: number, iz: number } & Partial<import('../scene/fixturesFromScene.js').CustomFixtureDescriptor>} FixtureDescriptor
 */

/**
 * Support and load glyphs for the current scene.
 * @param {string} _preset
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @param {import('../scene/types.js').Scene | null} [scene]
 * @returns {FixtureDescriptor[]}
 */
export function getFixtureDescriptors(_preset, nx, ny, nz, scene = null) {
  return scene ? /** @type {FixtureDescriptor[]} */ (getCustomFixtureDescriptors(scene, nx, ny, nz)) : [];
}
