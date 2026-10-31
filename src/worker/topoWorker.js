/**
 * Topology optimisation worker.
 *
 * Messages in:  INIT | RESET {nx,ny,nz,volfrac,penal,rmin,preset}
 *               STEP {batch}            fixed number of iterations, one reply
 *               RUN {runId}             iterate autonomously until PAUSE
 *               PAUSE {runId}           finish in-flight work, send final reply
 *               ACK                     main consumed a mid-run reply (back-pressure)
 *               UPDATE_PARAMS {volfrac?,penal?,rmin?}
 * Message out:  STATE_UPDATE { meta, densities, energies, dispY } (ArrayBuffers, transferred)
 *
 * meta: { iteration, compliance, cgResidual, maxDisp, avgVolume, batchSteps,
 *         backend, backendNote?, runEnded?, timings: { feaMs, filterOcMs, stepMs, batchMs } }
 *       (timings are per-iteration means; batchMs is the wall time since the last reply;
 *        on the GPU path feaMs = GPU-busy ms/iteration (FEA+filter+OC), filterOcMs = CPU
 *        mirror/post-processing ms)
 *       On failure: { error, backend, runEnded } with the last good buffers.
 *
 * Solver backends:
 *  - WebGPU: the whole iteration (PCG, sensitivity filter, OC bisection, density update)
 *    stays on the device; two iterations are kept queued so the GPU never waits for the
 *    CPU or the main thread (see `GpuPcgSolver.simpSubmit/simpCollect`).
 *  - CPU fallback: `stepSIMP` (with `backend.solve` or the built-in CPU PCG).
 */
import {
  INIT, RESET, STEP, RUN, PAUSE, ACK, UPDATE_PARAMS, STATE_UPDATE,
} from './protocol.js';
import { createSolverState, resetSolverState, updateSolverParams } from '../topo/solverState.js';
import { stepSIMP } from '../topo/simpStep.js';
import { getNodeIndex } from '../fea/indexing.js';

/** @type {import('../topo/solverState.js').SolverState | null} */
let state = null;

/** @type {{ solve: Function, getName: () => string, getInitError?: () => unknown } | null} */
let solver = null;
let backendNote = '';
/** @type {Promise<void> | null} */
let backendProbe = null;

// Resolved statically by Vite; empty object when the file is absent (CPU-only build).
const backendLoaders = import.meta.glob('../solver/backend.js');

function backendLabel(fromSolve) {
  if (fromSolve) {
    if (/gpu/i.test(fromSolve)) return 'WebGPU';
    if (solver?.isGpuAvailable?.()) return 'CPU · GPU ready';
    return 'CPU';
  }
  if (!solver) return 'CPU';
  const n = String(solver.getName?.() ?? 'cpu');
  if (/gpu/i.test(n)) return 'WebGPU';
  if (solver.isGpuAvailable?.()) return 'CPU · GPU ready';
  return 'CPU';
}

async function probeBackend() {
  const loader = backendLoaders['../solver/backend.js'];
  if (!loader) return;
  try {
    const mod = await loader();
    const create = mod.createSolverBackend ?? mod.createBackend ?? mod.default;
    if (typeof create !== 'function') throw new Error('backend.js exports no createSolverBackend()');
    const candidate = await create({
      preferGpu: true,
      autoTune: false, // keep WebGPU active for full device utilisation
      onFallback: (err) => {
        backendNote = `GPU solve failed, using CPU: ${err?.message ?? err}`;
      },
    });
    if (typeof candidate?.solve !== 'function') throw new Error('backend has no solve()');
    solver = candidate;
    const initErr = candidate.getInitError?.();
    if (initErr) backendNote = `GPU unavailable, using CPU: ${initErr?.message ?? initErr}`;
  } catch (err) {
    solver = null;
    backendNote = `Backend load failed, using CPU: ${err?.message ?? err}`;
  }
}

function ensureBackendProbe() {
  if (!backendProbe) backendProbe = probeBackend();
  return backendProbe;
}

function sampleDispY(s) {
  const out = new Float32Array(s.nx * s.ny * s.nz);
  const U = s.globalU;
  if (!U) return out;
  let idx = 0;
  for (let ez = 0; ez < s.nz; ez++) {
    for (let ey = 0; ey < s.ny; ey++) {
      for (let ex = 0; ex < s.nx; ex++, idx++) {
        const nBase = getNodeIndex(s.nx, s.ny, s.nz, ex, ey, ez);
        out[idx] = U[3 * nBase + 1] || 0;
      }
    }
  }
  return out;
}

function postState(meta) {
  const total = state ? state.nx * state.ny * state.nz : 0;
  const dens = new Float32Array(total);
  const ener = new Float32Array(total);
  let disp = new Float32Array(total);
  if (state) {
    dens.set(state.xPhys);
    ener.set(state.elementEnergies);
    if (state.dispY && state.dispY.length === total) disp.set(state.dispY);
    else disp = sampleDispY(state);
  }
  self.postMessage(
    { type: STATE_UPDATE, meta, densities: dens.buffer, energies: ener.buffer, dispY: disp.buffer },
    [dens.buffer, ener.buffer, disp.buffer],
  );
}

/** One SIMP iteration, FEA via backend when available. */
async function runOneStep() {
  state.dispY = null; // CPU path derives displacements from globalU
  if (!solver) {
    const meta = stepSIMP(state, { KE: state.KE });
    return { ...meta, solveBackend: 'cpu' };
  }
  const feaResult = await solver.solve({
    nx: state.nx,
    ny: state.ny,
    nz: state.nz,
    penal: state.penal,
    preset: state.preset,
    scene: state.scene,
    xPhys: state.xPhys,
    globalU: state.globalU,
    KE: state.KE,
    elementEnergies: state.elementEnergies,
  });
  if (feaResult.backendNote) backendNote = feaResult.backendNote;
  const meta = stepSIMP(state, { KE: state.KE, feaResult });
  return { ...meta, solveBackend: feaResult.backend ?? solver.getName() };
}

const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));
const gpuSimpReady = () => !!solver?.supportsSimp?.();

// --- autonomous run bookkeeping (touched from onmessage, outside the serial queue) ---
let runActive = false;
let currentRunId = -1;
let stopRequested = false;
/** runIds paused before their RUN message started executing. */
const cancelledRuns = new Set();
/** Mid-run replies posted but not yet ACKed by the main thread. */
let unacked = 0;

/**
 * Iterate SIMP either a fixed number of times (STEP) or until PAUSE (RUN).
 *
 * GPU path keeps up to two iterations queued: while the CPU mirrors the result of
 * iteration k (and the main thread renders it), iteration k+1 is already executing,
 * so the device is never starved by CPU phases or message latency.
 *
 * @param {{ maxIters: number, continuous: boolean }} opts
 */
async function iterate({ maxIters, continuous }) {
  const inflight = [];
  let submitted = 0;
  let acc = { steps: 0, fea: 0, filt: 0, last: null };
  let sinceReply = performance.now();
  let lastBackend = 'cpu';
  let lastMeta = null;

  const flush = (final, extra = {}) => {
    const n = Math.max(1, acc.steps);
    const now = performance.now();
    const last = acc.last ?? lastMeta;
    postState({
      iteration: last ? last.iteration : state.iteration,
      compliance: last ? last.compliance : 0,
      cgResidual: last ? last.cgResidual : 0,
      maxDisp: last ? last.maxDisp : 0,
      avgVolume: last ? last.avgVolume : state.volfrac,
      batchSteps: acc.steps,
      backend: backendLabel(lastBackend),
      backendNote,
      runEnded: final,
      timings: {
        feaMs: acc.fea / n,
        filterOcMs: acc.filt / n,
        stepMs: (now - sinceReply) / n,
        batchMs: now - sinceReply,
      },
      ...extra,
    });
    acc = { steps: 0, fea: 0, filt: 0, last: null };
    sinceReply = now;
  };

  const record = (m, solveBackend) => {
    acc.steps += 1;
    acc.last = m;
    lastMeta = m;
    lastBackend = solveBackend;
    const tm = m.timings;
    acc.fea += Number.isFinite(tm?.feaMs) ? tm.feaMs : 0;
    acc.filt += Number.isFinite(tm?.filterOcMs) ? tm.filterOcMs : 0;
  };

  const wantMore = () => !stopRequested && (continuous || submitted < maxIters);

  try {
    for (;;) {
      if (gpuSimpReady()) {
        try {
          while (wantMore() && inflight.length < 2) {
            inflight.push(solver.simpSubmit(state));
            submitted += 1;
          }
          if (!inflight.length) break;
          const ticket = inflight.shift();
          record(await solver.simpCollect(ticket, state), 'webgpu');
        } catch (err) {
          if (gpuSimpReady()) throw err;
          // Backend demoted itself to CPU: drop queued GPU work (the CPU mirror holds
          // the last collected iteration) and continue on the CPU path.
          submitted -= inflight.length;
          inflight.length = 0;
          backendNote = `GPU step failed, using CPU: ${err?.message ?? err}`;
          continue;
        }
      } else {
        if (!wantMore()) break;
        submitted += 1;
        const ts = performance.now();
        const m = await runOneStep();
        const dt = performance.now() - ts;
        const tm = m.timings;
        record(
          {
            ...m,
            timings: {
              feaMs: Number.isFinite(tm?.feaMs) ? tm.feaMs : dt,
              filterOcMs: Number.isFinite(tm?.filterOcMs) ? tm.filterOcMs : 0,
            },
          },
          m.solveBackend ?? 'cpu',
        );
        await yieldToEventLoop(); // let PAUSE / UPDATE_PARAMS messages through
      }

      if (continuous && unacked === 0 && acc.steps > 0) {
        unacked += 1;
        flush(false);
      }
    }
  } catch (err) {
    flush(true, { error: String(err?.message ?? err) });
    return;
  }
  flush(true);
}

async function handle(msg) {
  const { type, payload = {} } = msg;

  if (type === INIT || type === RESET) {
    if (!state) state = createSolverState(payload);
    else resetSolverState(state, payload);
    await ensureBackendProbe();
    postState({
      iteration: 0,
      compliance: 0,
      cgResidual: 0,
      maxDisp: 0,
      avgVolume: state.volfrac,
      batchSteps: 0,
      backend: backendLabel(),
      backendNote,
      timings: { feaMs: 0, filterOcMs: 0, stepMs: 0, batchMs: 0 },
    });
    return;
  }

  if (type === STEP || type === RUN) {
    if (!state) {
      postState({ error: 'Worker not initialised (send RESET first)', backend: backendLabel(), runEnded: true });
      return;
    }
    await ensureBackendProbe();
    if (type === RUN) {
      const id = payload.runId;
      if (cancelledRuns.delete(id)) {
        postState({ iteration: state.iteration, backend: backendLabel(), runEnded: true, batchSteps: 0 });
        return;
      }
      currentRunId = id;
    }
    runActive = true;
    stopRequested = false;
    unacked = 0;
    try {
      await iterate({
        maxIters: type === STEP ? Math.max(1, payload.batch | 0 || 1) : Infinity,
        continuous: type === RUN,
      });
    } finally {
      runActive = false;
    }
    return;
  }

  if (type === UPDATE_PARAMS) {
    if (state) updateSolverParams(state, payload);
  }
}

// Serialise handling: async backend probing/solves must not reorder messages.
// PAUSE / ACK / UPDATE_PARAMS-during-run bypass the queue (the run loop occupies it).
let queue = Promise.resolve();
self.onmessage = (e) => {
  const { type, payload = {} } = e.data;
  if (type === ACK) {
    unacked = Math.max(0, unacked - 1);
    return;
  }
  if (type === PAUSE) {
    if (runActive && currentRunId === payload.runId) stopRequested = true;
    else cancelledRuns.add(payload.runId);
    return;
  }
  if (type === UPDATE_PARAMS && runActive) {
    if (state) updateSolverParams(state, payload);
    return;
  }
  queue = queue
    .then(() => handle(e.data))
    .catch((err) => {
      console.error('[topoWorker]', err);
      runActive = false;
      try {
        postState({ error: String(err?.message ?? err), backend: backendLabel(), runEnded: true });
      } catch {
        /* ignore */
      }
    });
};
