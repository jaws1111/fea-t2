import { FEA_CONSTANTS } from '../config/defaults.js';
import { KE_24x24 } from '../fea/hex8Ke.js';
import { solveFEA } from '../fea/pcgSolver.js';
import { applyPassiveRegions, buildPassiveMask } from '../scene/passiveVoids.js';
import { loadCaseCount, solveLoadCasesSync } from './loadCases.js';
import { filterSensitivities } from './sensitivityFilter.js';

const { moveLimit } = FEA_CONSTANTS;
const XMIN = 0.001;

/**
 * One SIMP optimization iteration (FEA → filter → OC update).
 *
 * @param {import('./solverState.js').SolverState} state
 * @param {{
 *   KE?: Float32Array,
 *   feaResult?: ReturnType<typeof solveFEA> & { feaMs?: number },
 *   fixedDofs?: Uint8Array,
 *   F?: Float32Array,
 * }} [options]
 *   feaResult: precomputed FEA solve (e.g. from the GPU backend); skips the CPU solve.
 *   fixedDofs and F, when both are set, replace the scene boundary conditions for that solve.
 * @returns {{
 *   iteration: number,
 *   compliance: number,
 *   cgResidual: number,
 *   maxDisp: number,
 *   avgVolume: number,
 *   timings: { feaMs: number, filterOcMs: number },
 * }}
 */
export function stepSIMP(state, options = {}) {
  const KE = options.KE ?? state.KE ?? KE_24x24;
  const { nx, ny, nz, volfrac, penal, rmin, scene, x, xPhys } = state;
  const totalElements = nx * ny * nz;
  const targetVolume = volfrac * totalElements;

  // Passive mask: 1 = void (xmin), 2 = solid boss / pad (1). OC never redesigns these.
  const passive =
    scene ? buildPassiveMask(nx, ny, nz, scene) : null;

  const tFeaStart = performance.now();
  const feaResult =
    options.feaResult ??
    (loadCaseCount(state) > 1
      ? solveLoadCasesSync(state, (p) => solveFEA({ ...p, KE }))
      : solveFEA({
      nx,
      ny,
      nz,
      penal,
      scene,
      xPhys,
      globalU: state.globalU,
      KE,
      elementEnergies: state.elementEnergies,
      fixedDofs: options.fixedDofs,
      F: options.F,
    }));
  state.globalU = feaResult.U;
  const tFeaEnd = performance.now();

  const dcf = filterSensitivities({
    dc: feaResult.dc,
    xPhys,
    nx,
    ny,
    nz,
    rmin,
  });

  /**
   * Candidate density after OC move for element i at a given lambda.
   * Passive regions are locked.
   * @param {number} i
   * @param {number} lambda
   */
  function candidate(i, lambda) {
    if (passive) {
      if (passive[i] === 1) return XMIN;
      if (passive[i] === 2) return 1;
    }
    const B_e = Math.sqrt(Math.max(0, -dcf[i] / Math.max(lambda, 1e-12)));
    const trial = x[i] * B_e;
    return Math.max(
      XMIN,
      Math.max(x[i] - moveLimit, Math.min(1.0, Math.min(x[i] + moveLimit, trial))),
    );
  }

  /**
   * @param {number} lambda
   */
  function evaluateVolume(lambda) {
    let vol = 0;
    for (let i = 0; i < totalElements; i++) vol += candidate(i, lambda);
    return vol;
  }

  let l1 = 1e-6;
  let l2 = 1e8;
  let bracketIters = 0;
  while (evaluateVolume(l1) < targetVolume && bracketIters < 40) {
    l1 /= 10.0;
    bracketIters++;
  }
  bracketIters = 0;
  while (evaluateVolume(l2) > targetVolume && bracketIters < 40) {
    l2 *= 10.0;
    bracketIters++;
  }

  let lmid = 0.5 * (l1 + l2);
  for (let b = 0; b < 45; b++) {
    lmid = 0.5 * (l1 + l2);
    const vol = evaluateVolume(lmid);
    if (vol > targetVolume) l1 = lmid;
    else l2 = lmid;
    if ((l2 - l1) / (l1 + l2) < 1e-4) break;
  }

  let achievedVol = 0;
  for (let i = 0; i < totalElements; i++) {
    const updated = candidate(i, lmid);
    x[i] = updated;
    xPhys[i] = updated;
    achievedVol += updated;
  }

  // Belt-and-suspenders: re-assert passive regions (also covers init drift).
  if (scene) {
    applyPassiveRegions(x, xPhys, nx, ny, nz, scene, XMIN);
    achievedVol = 0;
    for (let i = 0; i < totalElements; i++) achievedVol += xPhys[i];
  }

  state.iteration += 1;

  return {
    iteration: state.iteration,
    compliance: feaResult.compliance,
    cgResidual: feaResult.cgResidual,
    maxDisp: feaResult.maxDisp,
    avgVolume: achievedVol / totalElements,
    timings: {
      feaMs: options.feaResult?.feaMs ?? tFeaEnd - tFeaStart,
      filterOcMs: performance.now() - tFeaEnd,
    },
  };
}
