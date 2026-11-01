import { FEA_CONSTANTS } from '../config/defaults.js';
import { applyBCs } from '../presets/boundaryConditions.js';
import { getElementDofs } from './indexing.js';

const { Emin, E0, maxIters, cgTol } = FEA_CONSTANTS;

/**
 * Continuous PCG FEA solve with SIMP-modulated Hex8 stiffness (worker parity).
 *
 * @param {{
 *   nx: number, ny: number, nz: number,
 *   penal: number,
 *   preset: string,
 *   scene?: import('../scene/types.js').Scene | null,
 *   loadCase?: number,
 *   xPhys: Float32Array,
 *   globalU: Float32Array | null,
 *   KE: Float32Array,
 *   elementEnergies?: Float32Array,
 *   fixedDofs?: Uint8Array,
 *   F?: Float32Array,
 * }} params
 * @returns {{
 *   dc: Float32Array,
 *   compliance: number,
 *   cgResidual: number,
 *   maxDisp: number,
 *   U: Float32Array,
 * }}
 */
export function solveFEA({
  nx,
  ny,
  nz,
  penal,
  preset,
  scene = null,
  loadCase = 0,
  xPhys,
  globalU,
  KE,
  elementEnergies,
  fixedDofs: fixedDofsIn = null,
  F: FIn = null,
}) {
  const totalElements = nx * ny * nz;
  const nNodes = (nx + 1) * (ny + 1) * (nz + 1);
  const totalDofs = 3 * nNodes;

  let fixedDofs;
  let F;
  if (fixedDofsIn || FIn) {
    if (!fixedDofsIn || !FIn || fixedDofsIn.length !== totalDofs || FIn.length !== totalDofs) {
      throw new Error('solveFEA fixedDofs and F must both cover every DOF');
    }
    fixedDofs = fixedDofsIn;
    F = FIn;
  } else {
    fixedDofs = new Uint8Array(totalDofs);
    F = new Float32Array(totalDofs);
    applyBCs(fixedDofs, F, nx, ny, nz, preset, scene, loadCase);
  }

  const diag = new Float32Array(totalDofs);
  const edofs = new Int32Array(24);
  let eIdx = 0;

  for (let ez = 0; ez < nz; ez++) {
    for (let ey = 0; ey < ny; ey++) {
      for (let ex = 0; ex < nx; ex++, eIdx++) {
        const rho = xPhys[eIdx];
        const E = Emin + Math.pow(rho, penal) * (E0 - Emin);
        getElementDofs(nx, ny, nz, ex, ey, ez, edofs);
        for (let i = 0; i < 24; i++) {
          diag[edofs[i]] += E * KE[i * 24 + i];
        }
      }
    }
  }

  const invDiag = new Float32Array(totalDofs);
  for (let i = 0; i < totalDofs; i++) {
    invDiag[i] = fixedDofs[i] || diag[i] < 1e-7 ? 1.0 : 1.0 / diag[i];
  }

  /**
   * @param {Float32Array} v
   * @param {Float32Array} out
   */
  function multiplyA(v, out) {
    out.fill(0);
    const localDofs = new Int32Array(24);
    let el = 0;
    for (let ez = 0; ez < nz; ez++) {
      for (let ey = 0; ey < ny; ey++) {
        for (let ex = 0; ex < nx; ex++, el++) {
          const rho = xPhys[el];
          const E = Emin + Math.pow(rho, penal) * (E0 - Emin);
          getElementDofs(nx, ny, nz, ex, ey, ez, localDofs);

          for (let i = 0; i < 24; i++) {
            const di = localDofs[i];
            if (fixedDofs[di]) continue;
            let sum = 0;
            for (let j = 0; j < 24; j++) {
              const dj = localDofs[j];
              if (!fixedDofs[dj]) {
                sum += KE[i * 24 + j] * v[dj];
              }
            }
            out[di] += E * sum;
          }
        }
      }
    }
    for (let i = 0; i < totalDofs; i++) {
      if (fixedDofs[i]) out[i] = v[i];
    }
  }

  let U = globalU;
  if (!U || U.length !== totalDofs) {
    U = new Float32Array(totalDofs);
  }

  const r = new Float32Array(totalDofs);
  const z = new Float32Array(totalDofs);
  const p = new Float32Array(totalDofs);
  const Ap = new Float32Array(totalDofs);

  multiplyA(U, Ap);
  for (let i = 0; i < totalDofs; i++) {
    if (!fixedDofs[i]) {
      r[i] = F[i] - Ap[i];
      z[i] = r[i] * invDiag[i];
      p[i] = z[i];
    } else {
      U[i] = 0;
      r[i] = 0;
      z[i] = 0;
      p[i] = 0;
    }
  }

  let rzOld = 0;
  for (let i = 0; i < totalDofs; i++) {
    if (!fixedDofs[i]) rzOld += r[i] * z[i];
  }

  let currentRes = Math.sqrt(Math.max(0, rzOld));

  for (let it = 0; it < maxIters; it++) {
    if (currentRes < cgTol) break;
    multiplyA(p, Ap);

    let pAp = 0;
    for (let i = 0; i < totalDofs; i++) {
      if (!fixedDofs[i]) pAp += p[i] * Ap[i];
    }
    if (Math.abs(pAp) < 1e-15) break;

    const alpha = rzOld / pAp;
    for (let i = 0; i < totalDofs; i++) {
      if (!fixedDofs[i]) {
        U[i] += alpha * p[i];
        r[i] -= alpha * Ap[i];
        z[i] = r[i] * invDiag[i];
      }
    }

    let rzNew = 0;
    for (let i = 0; i < totalDofs; i++) {
      if (!fixedDofs[i]) rzNew += r[i] * z[i];
    }
    currentRes = Math.sqrt(Math.max(0, rzNew));
    if (currentRes < cgTol) break;

    const beta = rzNew / rzOld;
    for (let i = 0; i < totalDofs; i++) {
      if (!fixedDofs[i]) p[i] = z[i] + beta * p[i];
    }
    rzOld = rzNew;
  }

  let maxU = 0;
  for (let i = 0; i < totalDofs; i++) {
    const mag = Math.abs(U[i]);
    if (mag > maxU) maxU = mag;
  }

  let totalCompliance = 0;
  const dc = new Float32Array(totalElements);
  const localU = new Float32Array(24);
  let elemIdx = 0;

  for (let ez = 0; ez < nz; ez++) {
    for (let ey = 0; ey < ny; ey++) {
      for (let ex = 0; ex < nx; ex++, elemIdx++) {
        getElementDofs(nx, ny, nz, ex, ey, ez, edofs);
        for (let i = 0; i < 24; i++) {
          localU[i] = fixedDofs[edofs[i]] ? 0 : U[edofs[i]];
        }
        let ce = 0;
        for (let i = 0; i < 24; i++) {
          const ui = localU[i];
          if (ui === 0) continue;
          for (let j = 0; j < 24; j++) {
            const uj = localU[j];
            if (uj !== 0) ce += ui * KE[i * 24 + j] * uj;
          }
        }
        ce = Math.max(ce, 1e-8);
        const rho = xPhys[elemIdx];
        const E = Emin + Math.pow(rho, penal) * (E0 - Emin);
        const strainEnergy = E * ce;

        totalCompliance += strainEnergy;
        if (elementEnergies) elementEnergies[elemIdx] = strainEnergy;
        dc[elemIdx] = -penal * Math.pow(Math.max(rho, 1e-4), penal - 1) * (E0 - Emin) * ce;
      }
    }
  }

  return {
    dc,
    compliance: totalCompliance,
    cgResidual: currentRes,
    maxDisp: maxU,
    U,
  };
}
