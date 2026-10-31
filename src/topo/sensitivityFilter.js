import { getElementIndex } from '../fea/indexing.js';

/**
 * Density-weighted sensitivity filter (SIMP OC, worker parity).
 *
 * @param {{
 *   dc: Float32Array,
 *   xPhys: Float32Array,
 *   nx: number, ny: number, nz: number,
 *   rmin: number,
 * }} params
 * @returns {Float32Array}
 */
export function filterSensitivities({ dc, xPhys, nx, ny, nz, rmin }) {
  const totalElements = nx * ny * nz;
  const rCeil = Math.ceil(rmin);
  const dcFiltered = new Float32Array(totalElements);

  let eIdx = 0;
  for (let ez = 0; ez < nz; ez++) {
    for (let ey = 0; ey < ny; ey++) {
      for (let ex = 0; ex < nx; ex++, eIdx++) {
        let sumWeights = 0;
        let sumWeightedSens = 0;
        const zMin = Math.max(0, ez - rCeil);
        const zMax = Math.min(nz - 1, ez + rCeil);
        const yMin = Math.max(0, ey - rCeil);
        const yMax = Math.min(ny - 1, ey + rCeil);
        const xMin = Math.max(0, ex - rCeil);
        const xMax = Math.min(nx - 1, ex + rCeil);

        for (let kz = zMin; kz <= zMax; kz++) {
          for (let ky = yMin; ky <= yMax; ky++) {
            for (let kx = xMin; kx <= xMax; kx++) {
              const dist = Math.hypot(ex - kx, ey - ky, ez - kz);
              if (dist < rmin) {
                const weight = rmin - dist;
                const nIdx = getElementIndex(nx, ny, nz, kx, ky, kz);
                sumWeights += weight;
                sumWeightedSens += weight * xPhys[nIdx] * dc[nIdx];
              }
            }
          }
        }
        const currentRho = Math.max(xPhys[eIdx], 1e-3);
        dcFiltered[eIdx] = sumWeights > 0 ? sumWeightedSens / (currentRho * sumWeights) : dc[eIdx];
      }
    }
  }
  return dcFiltered;
}
