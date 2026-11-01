import { fitDimsForBudget } from '../scene/domainFit.js';

/**
 * Problem archetypes: each one owns the shape of its working volume (the designable box).
 *
 * The boundary conditions in boundaryConditions.js are written against the domain faces
 * (supports on x = 0 / x = max, loads on the top face, …), so the box proportions below are
 * what makes each of them physically meaningful. They were reverse-engineered from those
 * definitions and the classic benchmark geometries; `volume` is a length ratio x : y : z
 * (x = span, y = height, z = width). The domain is this box meshed with cubic voxels at the cell
 * budget chosen in "Voxel Domain".
 *
 * @typedef {import('../config/defaults.js').PresetKey} PresetKey
 * @typedef {{ x: number, y: number, z: number }} VolumeShape
 * @typedef {{ label: string, volume: VolumeShape, rationale: string }} Archetype
 */

/** @type {Record<PresetKey, Archetype>} */
export const ARCHETYPES = Object.freeze({
  bridge: {
    label: 'Bridge Arch',
    // 36 : 15 : 8 — the original static grid of this archetype (span / rise = 2.4).
    volume: { x: 2.4, y: 1, z: 8 / 15 },
    rationale: 'Pinned at both bottom corners, one line load at mid-span on top; a shallow arch needs rise ≈ 0.4 × span.',
  },
  deck: {
    label: 'Deck Bridge',
    volume: { x: 4, y: 1, z: 2 / 3 },
    rationale: 'Pinned at both ends, road load spread over the whole top face; a slender girder (depth ≈ span / 4).',
  },
  cantilever: {
    label: 'Cantilever',
    volume: { x: 2, y: 1, z: 0.5 },
    rationale: 'Clamped wall at x = 0, tip load at mid-height; the classic 2 : 1 benchmark.',
  },
  mbb: {
    label: 'MBB Beam',
    volume: { x: 3, y: 1, z: 0.5 },
    rationale: 'Half MBB beam: symmetry plane at x = 0, roller at the far bottom corner; the classic 3 : 1 benchmark.',
  },
  michell: {
    label: 'Michell Wheel',
    volume: { x: 2, y: 1, z: 0.4 },
    rationale: 'Two forces at the bottom corners, rigid hub at the centre; a 2 : 1 strip so the spokes can fan out.',
  },
});

/** @param {string} key */
export const isArchetype = (key) => Object.prototype.hasOwnProperty.call(ARCHETYPES, key);

/**
 * Grid for an archetype: its volume shape meshed with cubic voxels, about `budget` cells.
 * @param {PresetKey} key
 * @param {number} budget
 * @returns {{ nx: number, ny: number, nz: number }}
 */
export function archetypeDims(key, budget) {
  return fitDimsForBudget(ARCHETYPES[key].volume, budget);
}