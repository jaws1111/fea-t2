import { getNodeIndex } from '../fea/indexing.js';
import { applyCustomBCs } from '../scene/applyCustomBCs.js';
import { getCustomFixtureDescriptors } from '../scene/fixturesFromScene.js';

/**
 * Apply preset boundary conditions to fixed DOF mask and load vector F.
 * @param {Uint8Array} fixedDofs
 * @param {Float32Array} F
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @param {string} preset
 * @param {import('../scene/types.js').Scene | null} [scene]  used when preset === 'custom'
 */
export function applyBCs(fixedDofs, F, nx, ny, nz, preset, scene = null, loadCase = 0) {
  if (preset === 'custom') {
    if (scene) applyCustomBCs(fixedDofs, F, nx, ny, nz, scene, loadCase);
    return;
  }
  if (preset === 'bridge') {
    for (let iz = 0; iz <= nz; iz++) {
      const nL = getNodeIndex(nx, ny, nz, 0, 0, iz);
      const nR = getNodeIndex(nx, ny, nz, nx, 0, iz);
      for (let d = 0; d < 3; d++) {
        fixedDofs[3 * nL + d] = 1;
        fixedDofs[3 * nR + d] = 1;
      }
    }
    const midX = Math.round(nx / 2);
    for (let iz = 0; iz <= nz; iz++) {
      const nLoad = getNodeIndex(nx, ny, nz, midX, ny, iz);
      F[3 * nLoad + 1] -= 1.0 / (nz + 1);
    }
  } else if (preset === 'deck') {
    for (let iz = 0; iz <= nz; iz++) {
      const nL = getNodeIndex(nx, ny, nz, 0, 0, iz);
      const nR = getNodeIndex(nx, ny, nz, nx, 0, iz);
      for (let d = 0; d < 3; d++) {
        fixedDofs[3 * nL + d] = 1;
        fixedDofs[3 * nR + d] = 1;
      }
    }
    const totalDeckNodes = (nx - 1) * (nz + 1);
    for (let ix = 1; ix < nx; ix++) {
      for (let iz = 0; iz <= nz; iz++) {
        const nLoad = getNodeIndex(nx, ny, nz, ix, ny, iz);
        F[3 * nLoad + 1] -= 1.0 / totalDeckNodes;
      }
    }
  } else if (preset === 'cantilever') {
    for (let iy = 0; iy <= ny; iy++) {
      for (let iz = 0; iz <= nz; iz++) {
        const nWall = getNodeIndex(nx, ny, nz, 0, iy, iz);
        for (let d = 0; d < 3; d++) fixedDofs[3 * nWall + d] = 1;
      }
    }
    const midY = Math.round(ny / 2);
    for (let iz = 0; iz <= nz; iz++) {
      const nTip = getNodeIndex(nx, ny, nz, nx, midY, iz);
      F[3 * nTip + 1] -= 1.0 / (nz + 1);
    }
  } else if (preset === 'mbb') {
    for (let iy = 0; iy <= ny; iy++) {
      for (let iz = 0; iz <= nz; iz++) {
        const nL = getNodeIndex(nx, ny, nz, 0, iy, iz);
        fixedDofs[3 * nL] = 1;
      }
    }
    for (let iz = 0; iz <= nz; iz++) {
      const nR = getNodeIndex(nx, ny, nz, nx, 0, iz);
      fixedDofs[3 * nR + 1] = 1;
      fixedDofs[3 * nR + 2] = 1;
    }
    for (let iz = 0; iz <= nz; iz++) {
      const nLoad = getNodeIndex(nx, ny, nz, 0, ny, iz);
      F[3 * nLoad + 1] -= 0.5 / (nz + 1);
    }
  } else if (preset === 'michell') {
    const midX = Math.round(nx / 2);
    const midY = Math.round(ny / 2);
    for (let iz = 0; iz <= nz; iz++) {
      const nCenter = getNodeIndex(nx, ny, nz, midX, midY, iz);
      for (let d = 0; d < 3; d++) fixedDofs[3 * nCenter + d] = 1;
    }
    for (let iz = 0; iz <= nz; iz++) {
      const n1 = getNodeIndex(nx, ny, nz, 1, 0, iz);
      const n2 = getNodeIndex(nx, ny, nz, nx - 1, 0, iz);
      F[3 * n1 + 1] -= 0.5 / (nz + 1);
      F[3 * n2 + 1] -= 0.5 / (nz + 1);
    }
  }
}

/**
 * @typedef {'pier'|'wall'|'sym'|'axle'|'load'|'rest'|'bolt'|'bolt_force'|'pressure'|'road'} FixtureKind
 * @typedef {{ kind: FixtureKind, ix: number, iy: number, iz: number } & Partial<import('../scene/fixturesFromScene.js').CustomFixtureDescriptor>} FixtureDescriptor
 */

/**
 * Visualization fixtures aligned with updateBoundaryFixtures in the studio HTML (deduped).
 * @param {string} preset
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @param {import('../scene/types.js').Scene | null} [scene]  used when preset === 'custom'
 * @returns {FixtureDescriptor[]}
 */
export function getFixtureDescriptors(preset, nx, ny, nz, scene = null) {
  if (preset === 'custom') {
    return scene ? /** @type {FixtureDescriptor[]} */ (getCustomFixtureDescriptors(scene, nx, ny, nz)) : [];
  }

  /** @type {FixtureDescriptor[]} */
  const raw = [];

  if (preset === 'bridge') {
    for (let iz = 0; iz <= nz; iz++) {
      raw.push({ kind: 'pier', ix: 0, iy: 0, iz });
      raw.push({ kind: 'pier', ix: nx, iy: 0, iz });
    }
    const midX = Math.round(nx / 2);
    for (let iz = 1; iz < nz; iz++) {
      raw.push({ kind: 'load', ix: midX, iy: ny, iz });
    }
  } else if (preset === 'deck') {
    for (let iz = 0; iz <= nz; iz++) {
      raw.push({ kind: 'pier', ix: 0, iy: 0, iz });
      raw.push({ kind: 'pier', ix: nx, iy: 0, iz });
    }
    // Uniform road pressure: every top node carries load (see applyBCs), so draw a road
    // slab plus a regular grid of arrows spread over the whole deck plane.
    raw.push({ kind: 'road', ix: 1, iy: ny, iz: 0, ix1: nx - 1, iz1: nz });
    const spread = (n0, n1, maxCount) => {
      const len = n1 - n0;
      const count = Math.max(1, Math.min(len + 1, maxCount));
      const out = [];
      for (let k = 0; k < count; k++) {
        out.push(count === 1 ? Math.round((n0 + n1) / 2) : Math.round(n0 + (len * k) / (count - 1)));
      }
      return out;
    };
    const arrowScale = nx >= 40 ? 0.55 : 0.7;
    for (const ix of spread(1, nx - 1, 16)) {
      for (const iz of spread(0, nz, 6)) {
        raw.push({ kind: 'load', ix, iy: ny, iz, dir: { x: 0, y: -1, z: 0 }, scale: arrowScale });
      }
    }
  } else if (preset === 'cantilever') {
    for (let iy = 0; iy <= ny; iy += 2) {
      for (let iz = 0; iz <= nz; iz += 2) {
        raw.push({ kind: 'wall', ix: 0, iy, iz });
      }
    }
    const midY = Math.round(ny / 2);
    for (let iz = 1; iz < nz; iz++) {
      raw.push({ kind: 'load', ix: nx, iy: midY, iz });
    }
  } else if (preset === 'mbb') {
    const midZ = Math.round(nz / 2);
    for (let iy = 0; iy <= ny; iy += 2) {
      raw.push({ kind: 'sym', ix: 0, iy, iz: midZ });
    }
    for (let iz = 0; iz <= nz; iz++) {
      raw.push({ kind: 'pier', ix: nx, iy: 0, iz });
    }
    raw.push({ kind: 'load', ix: 0, iy: ny, iz: midZ });
  } else if (preset === 'michell') {
    const midX = Math.round(nx / 2);
    const midY = Math.round(ny / 2);
    const midZ = Math.round(nz / 2);
    for (let iz = 0; iz <= nz; iz++) {
      raw.push({ kind: 'axle', ix: midX, iy: midY, iz });
    }
    raw.push({ kind: 'load', ix: 2, iy: 0, iz: midZ });
    raw.push({ kind: 'load', ix: nx - 2, iy: 0, iz: midZ });
  }

  const seen = new Set();
  /** @type {FixtureDescriptor[]} */
  const out = [];
  for (const f of raw) {
    const key = `${f.kind}:${f.ix},${f.iy},${f.iz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
