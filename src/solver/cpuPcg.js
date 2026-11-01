import { KE_24x24 } from '../fea/hex8Ke.js';
import { solveFEA } from '../fea/pcgSolver.js';

export { solveFEA };

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * CPU backend with the common solver interface:
 *   async init()
 *   async solve({ nx,ny,nz,penal,scene,xPhys,globalU,KE }) ->
 *     { dc, compliance, cgResidual, maxDisp, U, backend:'cpu', feaMs }
 */
export class CpuPcgSolver {
  constructor() {
    this.backend = 'cpu';
  }

  async init() {
    return true;
  }

  getName() {
    return 'cpu';
  }

  /**
   * @param {{
   *   nx: number, ny: number, nz: number, penal: number, scene?: import('../scene/types.js').Scene | null,
   *   xPhys: Float32Array, globalU?: Float32Array | null, KE?: Float32Array,
   *   elementEnergies?: Float32Array,
   * }} params
   */
  async solve(params) {
    const t0 = now();
    const result = solveFEA({
      ...params,
      globalU: params.globalU ?? null,
      KE: params.KE ?? KE_24x24,
    });
    return { ...result, backend: 'cpu', feaMs: now() - t0 };
  }

  dispose() {}
}

/** Shared default instance. */
export const cpuPcg = new CpuPcgSolver();

export function createCpuSolver() {
  return new CpuPcgSolver();
}
