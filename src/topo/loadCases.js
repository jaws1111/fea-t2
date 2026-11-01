import { sceneLoadCaseCount } from '../scene/pointLoad.js';

/**
 * Multiple load cases per SIMP iteration (custom scenes with multi-axis point loads in
 * 'cases' mode). Each case is its own FEA solve with its own load vector; the optimizer
 * minimises the SUM of the case compliances, so the design is stiff for every case:
 *
 *     C = Σ_k F_kᵀ u_k ,   dC/dρ_e = Σ_k dC_k/dρ_e   (sensitivities and energies simply add).
 *
 * Every case keeps its own warm-start displacement vector.
 */

/** @param {import('./solverState.js').SolverState} state */
export function loadCaseCount(state) {
  return sceneLoadCaseCount(state?.scene);
}

/**
 * Solver params for case `k` (energies go to a scratch array, summed in `mergeCaseResults`).
 * @param {import('./solverState.js').SolverState} state
 */
export function caseParams(state, k, count = loadCaseCount(state)) {
  const nDofs = 3 * (state.nx + 1) * (state.ny + 1) * (state.nz + 1);
  const nEl = state.nx * state.ny * state.nz;
  if (!Array.isArray(state.caseU) || state.caseU.length !== count) state.caseU = new Array(count).fill(null);
  if (state.caseU[k] && state.caseU[k].length !== nDofs) state.caseU[k] = null;
  if (!Array.isArray(state.caseEner) || state.caseEner.length !== count || state.caseEner[0]?.length !== nEl) {
    state.caseEner = Array.from({ length: count }, () => new Float32Array(nEl));
  }
  return {
    nx: state.nx,
    ny: state.ny,
    nz: state.nz,
    penal: state.penal,
    scene: state.scene,
    xPhys: state.xPhys,
    KE: state.KE,
    loadCase: k,
    globalU: state.caseU[k],
    elementEnergies: state.caseEner[k],
  };
}

/**
 * Sum per-case FEA results into one (dc, compliance, energies add; residual / displacement
 * take the worst case; `U` is the most compliant case's displacement, used for display).
 * @param {import('./solverState.js').SolverState} state
 * @param {any[]} results
 */
export function mergeCaseResults(state, results) {
  const nEl = state.nx * state.ny * state.nz;
  const dc = new Float32Array(nEl);
  state.elementEnergies.fill(0);
  let compliance = 0;
  let cgResidual = 0;
  let maxDisp = 0;
  let feaMs = 0;
  let worst = 0;
  results.forEach((r, k) => {
    state.caseU[k] = r.U;
    for (let i = 0; i < nEl; i++) {
      dc[i] += r.dc[i];
      state.elementEnergies[i] += state.caseEner[k][i];
    }
    compliance += r.compliance;
    cgResidual = Math.max(cgResidual, r.cgResidual);
    maxDisp = Math.max(maxDisp, r.maxDisp);
    feaMs += Number.isFinite(r.feaMs) ? r.feaMs : 0;
    if (r.compliance > results[worst].compliance) worst = k;
  });
  const last = results[results.length - 1];
  return {
    ...last,
    dc,
    compliance,
    cgResidual,
    maxDisp,
    U: results[worst].U,
    feaMs: feaMs || undefined,
  };
}

/**
 * @param {import('./solverState.js').SolverState} state
 * @param {(params: any) => any} solveOne  synchronous FEA for one case
 */
export function solveLoadCasesSync(state, solveOne) {
  const count = loadCaseCount(state);
  const results = [];
  for (let k = 0; k < count; k++) results.push(solveOne(caseParams(state, k, count)));
  return mergeCaseResults(state, results);
}

/**
 * @param {import('./solverState.js').SolverState} state
 * @param {(params: any) => Promise<any>} solveOne  FEA for one case (CPU or GPU backend)
 */
export async function solveLoadCasesAsync(state, solveOne) {
  const count = loadCaseCount(state);
  const results = [];
  for (let k = 0; k < count; k++) results.push(await solveOne(caseParams(state, k, count)));
  return mergeCaseResults(state, results);
}
