import { CpuPcgSolver } from './cpuPcg.js';
import { GpuPcgSolver, MAX_IN_FLIGHT } from './gpu/pcgPipeline.js';

/**
 * Prefer WebGPU whenever it initialises. CPU is fallback only.
 * autoTune=false keeps the GPU path active so device utilisation stays high.
 */
export async function createSolverBackend(options = {}) {
  const {
    preferGpu = true,
    autoTune = false,
    fallbackOnError = true,
    gpuOptions,
    onFallback,
  } = options;

  const cpu = new CpuPcgSolver();
  await cpu.init();

  /** @type {GpuPcgSolver | null} */
  let gpu = null;
  let initError = null;
  let gpuReady = false;

  if (preferGpu) {
    try {
      const candidate = new GpuPcgSolver(gpuOptions);
      await candidate.init();
      gpu = candidate;
      gpuReady = true;
    } catch (err) {
      initError = err;
      gpu = null;
    }
  }

  /** @type {CpuPcgSolver | GpuPcgSolver} */
  let active = gpu ?? cpu;

  const demote = (err) => {
    initError = err;
    try {
      gpu?.dispose();
    } catch {
      /* ignore */
    }
    gpu = null;
    gpuReady = false;
    active = cpu;
    if (onFallback) onFallback(err);
  };

  return {
    getName: () => active.getName(),
    getInitError: () => initError,
    isGpuAvailable: () => gpuReady,
    async init() {
      return true;
    },
    async solve(params) {
      // Always use GPU when ready (unless autoTune forces size heuristic — off by default).
      if (gpu && gpuReady) {
        if (autoTune) {
          const n = (params.nx | 0) * (params.ny | 0) * (params.nz | 0);
          active = n >= 2000 ? gpu : cpu;
        } else {
          active = gpu;
        }
      } else {
        active = cpu;
      }

      if (active === cpu) {
        const result = await cpu.solve(params);
        return {
          ...result,
          backend: 'cpu',
          backendNote: gpuReady ? 'CPU (autoTune)' : undefined,
        };
      }

      try {
        return await active.solve(params);
      } catch (err) {
        if (!fallbackOnError) throw err;
        demote(err);
        return cpu.solve(params);
      }
    },
    /** True while the GPU-resident SIMP path (FEA + filter + OC on device) is usable. */
    supportsSimp: () => !!(gpu && gpuReady && gpu.simpSubmit),
    /** How many SIMP iterations the worker may keep queued on the device. */
    maxInFlight: MAX_IN_FLIGHT,
    simpSubmit(state) {
      if (!gpu || !gpuReady) throw new Error('GPU backend unavailable');
      try {
        return gpu.simpSubmit(state);
      } catch (err) {
        if (fallbackOnError) demote(err);
        throw err;
      }
    },
    async simpCollect(ticket, state) {
      if (!gpu || !gpuReady) throw new Error('GPU backend unavailable');
      try {
        return await gpu.simpCollect(ticket, state);
      } catch (err) {
        if (fallbackOnError) demote(err);
        throw err;
      }
    },
    /** Pull the device-resident densities / energies / displacements into `state`. */
    async simpMirror(state) {
      if (!gpu || !gpuReady) throw new Error('GPU backend unavailable');
      try {
        return await gpu.simpMirror(state);
      } catch (err) {
        if (fallbackOnError) demote(err);
        throw err;
      }
    },
    dispose() {
      gpu?.dispose();
    },
  };
}
