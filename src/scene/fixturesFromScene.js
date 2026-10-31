import { holeLoadVectors } from './applyCustomBCs.js';
import { holeAxialRange, holeFrame, holeRadiusCells, sphereRadiusCells, validAxis } from './geometry.js';
import { normToNodeIndices } from './tools.js';
import { resolveWorkingBounds } from './workingVolume.js';

/**
 * Visualization descriptor for a custom scene feature. Compatible with the preset
 * `FixtureDescriptor` (kind + node indices) plus optional glyph metadata.
 *
 * kinds:
 *   fixations: 'rest' | 'bolt' | 'wall'
 *   forces:    'load' | 'pressure'
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
 * @property {'sphere'|'box'} [shape] pressure cavity shape
 * @property {boolean} [outward]      radial pressure points away from cavity centre
 * @property {boolean} [radial]       pressure acts radially (vs along `dir`)
 * @property {{ x: number, y: number, z: number }} [half]  box cavity half-extents (node units)
 * @property {number} [wall]          pressure wall thickness (cells)
 * @property {boolean} [cavity]       pressure carves a void cavity + wall
 */

function unitDir(fx, fy, fz, magnitude) {
  let x = Number(fx) || 0;
  let y = Number(fy) || 0;
  let z = Number(fz) || 0;
  if (magnitude < 0) {
    x = -x;
    y = -y;
    z = -z;
  }
  const l = Math.hypot(x, y, z);
  if (l < 1e-12) return { x: 0, y: -1, z: 0 };
  return { x: x / l, y: y / l, z: z / l };
}

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
  const maxDim = Math.max(nx, ny, nz);
  const wb = resolveWorkingBounds(scene, dims);

  for (const f of scene.fixations ?? []) {
    if (!f) continue;
    const c = normToNodeIndices(nx, ny, nz, f.x, f.y, f.z);
    switch (f.type) {
      case 'rest_point':
        out.push({
          kind: 'rest',
          id: f.id,
          ix: c.ix,
          iy: c.iy,
          iz: c.iz,
          radius: Math.max(0.5, (f.radius ?? 0.02) * maxDim),
        });
        break;
      case 'bolt_hole': {
        const axis = validAxis(f.axis);
        const nA = axis === 'x' ? nx : axis === 'y' ? ny : nz;
        const range = holeAxialRange(f, wb, axis, nA) ?? [0, nA - 1];
        const loads = holeLoadVectors(f).map((l) => ({
          dir: { x: l.dir[0], y: l.dir[1], z: l.dir[2] },
          mag: l.mag,
        }));
        const mag = Number.isFinite(f.magnitude) ? f.magnitude : 1;
        out.push({
          kind: 'bolt',
          id: f.id,
          ix: c.ix,
          iy: c.iy,
          iz: c.iz,
          axis,
          a0: range[0],
          a1: range[1] + 1,
          radius: holeRadiusCells(f.radius, maxDim),
          fixed: { x: f.fixX !== false, y: f.fixY !== false, z: f.fixZ !== false },
          loads,
          circ:
            f.loadMode === 'circular' && mag !== 0
              ? { mode: f.circMode === 'radial' ? 'radial' : 'torque', sign: mag < 0 ? -1 : 1 }
              : undefined,
        });
        break;
      }
      case 'wall_pad': {
        const face = ['x-', 'x+', 'y-', 'y+', 'z-', 'z+'].includes(f.face) ? f.face : 'x-';
        const axis = face[0];
        // Anchor the glyph on the face itself, centred on the patch.
        const high = face[1] === '+';
        const pos = { ix: c.ix, iy: c.iy, iz: c.iz };
        if (axis === 'x') pos.ix = high ? nx : 0;
        else if (axis === 'y') pos.iy = high ? ny : 0;
        else pos.iz = high ? nz : 0;
        const d = axis === 'x' ? [ny, nz] : axis === 'y' ? [nx, nz] : [nx, ny];
        out.push({
          kind: 'wall',
          id: f.id,
          ix: pos.ix,
          iy: pos.iy,
          iz: pos.iz,
          face,
          w: Math.min(1, Math.max(0, f.width ?? 1)) * d[0],
          h: Math.min(1, Math.max(0, f.height ?? 1)) * d[1],
        });
        break;
      }
      default:
        break;
    }
  }

  for (const f of scene.forces ?? []) {
    if (!f) continue;
    const c = normToNodeIndices(nx, ny, nz, f.x, f.y, f.z);
    const mag = Number.isFinite(f.magnitude) ? f.magnitude : 1;
    const dir = unitDir(f.fx, f.fy, f.fz, mag);
    switch (f.type) {
      case 'point_load':
        out.push({ kind: 'load', id: f.id, ix: c.ix, iy: c.iy, iz: c.iz, dir });
        break;
      case 'pressure': {
        const shape = f.shape === 'box' ? 'box' : 'sphere';
        const radial = f.pressureMode !== 'directional';
        out.push({
          kind: 'pressure',
          id: f.id,
          ix: c.ix,
          iy: c.iy,
          iz: c.iz,
          shape,
          radial,
          outward: !f.inward !== (mag < 0),
          dir,
          radius: sphereRadiusCells(f.radius, maxDim),
          cavity: f.cavityVoid !== false,
          wall: Math.max(1, Math.min(6, Math.round(Number(f.wall) || 2))),
          half:
            shape === 'box'
              ? {
                  x: Math.max(1, Math.round(Math.abs(f.hx ?? 0.1) * nx)),
                  y: Math.max(1, Math.round(Math.abs(f.hy ?? 0.1) * ny)),
                  z: Math.max(1, Math.round(Math.abs(f.hz ?? 0.1) * nz)),
                }
              : undefined,
        });
        break;
      }
      default:
        break;
    }
  }

  return out;
}

// re-export for callers that only need the frame helper
export { holeFrame };
