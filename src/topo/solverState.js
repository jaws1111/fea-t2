import { KE_24x24 } from '../fea/hex8Ke.js';
import { applyPassiveRegions } from '../scene/passiveVoids.js';
import { seedDensity } from './resample.js';

/**
 * @typedef {Object} SolverState
 * @property {number} nx
 * @property {number} ny
 * @property {number} nz
 * @property {number} volfrac
 * @property {number} penal
 * @property {number} rmin
 * @property {string} preset
 * @property {import('../scene/types.js').Scene | null} scene  custom scene (preset === 'custom')
 * @property {Float32Array} x
 * @property {Float32Array} xPhys
 * @property {Float32Array} elementEnergies
 * @property {Float32Array | null} globalU
 * @property {Float32Array | null} dispY   GPU path: per-element y-displacement mirror
 * @property {number} xVersion             bumped whenever x is rewritten outside the solver
 * @property {number} iteration
 * @property {Float32Array} KE
 */

/**
 * @param {{
 *   nx: number, ny: number, nz: number,
 *   volfrac: number, penal: number, rmin: number,
 *   preset: string,
 *   scene?: import('../scene/types.js').Scene | null,
 *   KE?: Float32Array,
 * }} params
 * @returns {SolverState}
 */
export function createSolverState(params) {
  const {
    nx,
    ny,
    nz,
    volfrac,
    penal,
    rmin,
    preset,
    scene = null,
    KE = KE_24x24,
  } = params;

  const totalElements = nx * ny * nz;
  const x = new Float32Array(totalElements);
  const xPhys = new Float32Array(totalElements);
  const elementEnergies = new Float32Array(totalElements);

  for (let i = 0; i < totalElements; i++) {
    x[i] = volfrac;
    xPhys[i] = volfrac;
    elementEnergies[i] = 1.0;
  }
  seedDensity(x, xPhys, nx, ny, nz, params.initDensity);
  if (preset === 'custom') applyPassiveRegions(x, xPhys, nx, ny, nz, scene);

  return {
    nx,
    ny,
    nz,
    volfrac,
    penal,
    rmin,
    preset,
    scene,
    x,
    xPhys,
    elementEnergies,
    globalU: null,
    dispY: null,
    xVersion: 0,
    iteration: 0,
    KE,
  };
}

/**
 * Reset solver buffers and parameters (worker resetSolver parity).
 *
 * @param {SolverState} state
 * @param {{
 *   nx: number, ny: number, nz: number,
 *   volfrac: number, penal: number, rmin: number,
 *   preset: string,
 *   scene?: import('../scene/types.js').Scene | null,
 * }} params
 * @returns {SolverState}
 */
export function resetSolverState(state, params) {
  const {
    nx,
    ny,
    nz,
    volfrac,
    penal,
    rmin,
    preset,
    scene = null,
  } = params;

  state.nx = nx;
  state.ny = ny;
  state.nz = nz;
  state.volfrac = volfrac;
  state.penal = penal;
  state.rmin = rmin;
  state.preset = preset;
  state.scene = scene;
  state.iteration = 0;

  const totalElements = nx * ny * nz;

  if (!state.x || state.x.length !== totalElements) {
    state.x = new Float32Array(totalElements);
    state.xPhys = new Float32Array(totalElements);
    state.elementEnergies = new Float32Array(totalElements);
  }

  for (let i = 0; i < totalElements; i++) {
    state.x[i] = volfrac;
    state.xPhys[i] = volfrac;
    state.elementEnergies[i] = 1.0;
  }
  // Warm start from a coarser/finer previous result (Stage Optimizer).
  seedDensity(state.x, state.xPhys, nx, ny, nz, params.initDensity);
  if (preset === 'custom') applyPassiveRegions(state.x, state.xPhys, nx, ny, nz, scene);

  state.globalU = null;
  state.caseU = null; // per-load-case warm starts (see loadCases.js)
  state.dispY = null;
  state.xVersion = (state.xVersion | 0) + 1; // tells the GPU backend to re-upload densities
  if (!state.KE) state.KE = KE_24x24;

  return state;
}

/**
 * Apply runtime param updates without full grid reset (UPDATE_PARAMS parity).
 *
 * @param {SolverState} state
 * @param {{ volfrac?: number, penal?: number, rmin?: number }} payload
 */
export function updateSolverParams(state, payload) {
  if (payload.volfrac !== undefined) state.volfrac = payload.volfrac;
  if (payload.penal !== undefined) state.penal = payload.penal;
  if (payload.rmin !== undefined) state.rmin = payload.rmin;
}
